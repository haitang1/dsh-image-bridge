/**
 * dsh-image-bridge
 *
 * 让文本模型（如 DeepSeek，inputModalities 只有 text）也能正常粘贴并发送图片：
 *  - 图片落盘到会话工作区 `.attachments/`；
 *  - 图片块保留在消息里（客户端照常渲染缩略图、可点击放大）；
 *  - 通过 DSH surface replace 机制，把图片在「模型可见面」替换成 `[图片N]:"<路径>"`，
 *    模型据此调用视觉/MCP 工具（vision_glance / mcp__mcp-vision__analyze_image 等）识别；
 *  - 支持图片的模型不做任何处理，走原生路径。
 */

const name = "image-bridge";

const inject = ["attachments", "llm", "subprocess", "sandboxPolicy"];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 === -1 ? 0 : b1 >> 4)];
    out += b1 === -1 ? "=" : B64[((b1 & 15) << 2) | (b2 === -1 ? 0 : b2 >> 6)];
    out += b2 === -1 ? "=" : B64[b2 & 63];
  }
  return out;
}

function extFor(mediaType) {
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/webp") return ".webp";
  if (mediaType === "image/gif") return ".gif";
  return ".png";
}

function shaOf(ref) {
  const id = String(ref && ref.attachmentId ? ref.attachmentId : "");
  return id.indexOf("sha256:") === 0 ? id.slice(7) : id;
}

function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

function apply(ctx) {
  const attachments = ctx.attachments;
  const llm = ctx.llm;
  const subprocess = ctx.subprocess;
  const sandboxPolicy = ctx.sandboxPolicy;

  // Part 1: 让 api-proxy 的预检放行含图 prompt（对文本模型）。
  // 预检用 `llm.resolveModelInfo(...).inputModalities` 判断是否支持图片；
  // 这里把文本模型的结果补上 "image"，从而让消息能进入 agent 流程。
  let originalResolve;
  ctx.effect(() => {
    if (typeof llm.resolveModelInfo !== "function") return () => {};
    originalResolve = llm.resolveModelInfo.bind(llm);
    llm.resolveModelInfo = async (provider, model, signal) => {
      const info = await originalResolve(provider, model, signal);
      const mods = info && Array.isArray(info.inputModalities) ? info.inputModalities : [];
      if (!mods.includes("image")) {
        return { ...(info || {}), inputModalities: [...mods, "image"] };
      }
      return info;
    };
    return () => {
      try {
        delete llm.resolveModelInfo;
      } catch (_) {
        /* 还原失败忽略：实例会随进程退出 */
      }
    };
  });

  // Part 1.5: 引导模型用识图工具（MCP/插件/skill）识别图片，避免用通用文件读取方式代替。
  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: "image-bridge:vision-guidance",
      order: 150,
      text: '当用户消息中出现 `[图片N]:"<绝对路径>"` 时，表示用户附带了第 N 张图片，图片已保存到该路径。当前模型无法直接查看图片内容，请优先使用可用的 MCP 识图工具（视觉分析/OCR 类），或其他图片识别插件与 skill 来识别图片；不要用通用文件读取方式代替图片识别。识别后结合图片内容与用户问题回答。'
    });
  }

  function workspaceRootFor(agent) {
    try {
      const policy = sandboxPolicy.resolve({ session: agent && agent.session });
      if (policy && typeof policy.workspaceRoot === "string" && policy.workspaceRoot.length > 0) {
        return policy.workspaceRoot;
      }
    } catch (_) {
      /* fall through */
    }
    if (typeof sandboxPolicy.workspaceRoot === "string") return sandboxPolicy.workspaceRoot;
    return "";
  }

  function currentModel(agent) {
    try {
      const header = agent && agent.session ? agent.session.requestHeader() : undefined;
      const cfg = header && header.config;
      if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model };
    } catch (_) {
      /* fall through */
    }
    if (agent && agent.options && agent.options.provider && agent.options.model) {
      return { provider: agent.options.provider, model: agent.options.model };
    }
    return null;
  }

  async function writeImageFile(data, destPath, root, signal) {
    if (!root || root.length === 0) return false;
    const node = await subprocess.resolveExecutable("node", undefined, signal);
    const script =
      'const fs=require("fs"),p=require("path");' +
      'fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true});' +
      'fs.writeFileSync(process.argv[1],Buffer.from(fs.readFileSync(0,"utf8"),"base64"))';
    const handle = subprocess.spawn({
      argv: [node, "-e", script, destPath],
      cwd: root,
      stdio: {
        stdin: { data: bytesToBase64(data) },
        stdout: { maxBytes: 1024 },
        stderr: "inherit",
      },
      graceMs: 30000,
      signal,
    });
    const outcome = await handle.done;
    return outcome.exitCode === 0;
  }

  // 每个 step 的状态：attachmentId -> 落盘路径（内容寻址，按 step 重置）。
  let imagePaths = new Map();

  async function modelSupportsImages(agent) {
    if (typeof originalResolve !== "function") return false;
    const cur = currentModel(agent);
    if (!cur) return false;
    try {
      const info = await originalResolve(cur.provider, cur.model);
      return !!(info && Array.isArray(info.inputModalities) && info.inputModalities.includes("image"));
    } catch (_) {
      return false;
    }
  }

  // Part 2: 写盘 + 记录路径，但保留图片块（客户端渲染缩略图）。
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind !== "enter" || !Array.isArray(decision.messages)) return decision;
    imagePaths = new Map();
    if (!(await modelSupportsImages(payload.agent))) {
      const root = workspaceRootFor(payload.agent);
      for (const message of decision.messages) {
        if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
        for (const block of message.content) {
          if (!block || block.type !== "image") continue;
          const id = String(
            block.attachment && block.attachment.attachmentId ? block.attachment.attachmentId : ""
          );
          try {
            const stored = await attachments.readImage(block.attachment, payload.signal);
            const ref = stored.ref;
            const base = shaOf(ref) || ("img-" + Date.now() + "-" + Math.random().toString(16).slice(2));
            const destPath =
              toPosix(root).replace(/\/+$/, "") + "/.attachments/" + base + extFor(ref.mediaType);
            const ok = await writeImageFile(stored.data, destPath, root, payload.signal);
            if (ok && id) imagePaths.set(id, destPath);
          } catch (err) {
            console.warn("image-bridge: prepare failed:", String(err && err.message ? err.message : err));
          }
        }
      }
    }
    return decision;
  });

  function buildTextVersion(message) {
    const newContent = [];
    let idx = 0;
    for (const block of message.content) {
      if (block && block.type === "image") {
        idx += 1;
        const id = String(
          block.attachment && block.attachment.attachmentId ? block.attachment.attachmentId : ""
        );
        const path = imagePaths.get(id);
        newContent.push({
          type: "text",
          text: '[图片' + idx + ']:"' + (path || "(保存失败)") + '"',
        });
      } else {
        newContent.push(block);
      }
    }
    return { ...message, content: newContent };
  }

  // 从日志尾部向前扫描当前 step 内的图片消息（停在 step/start）。
  function findImageMessages(agent) {
    const events = agent && agent.session ? agent.session.events : [];
    const targets = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === "step/start") break;
      if (ev.type !== "user/message") continue;
      const msg = ev.data;
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block && block.type === "image") {
          const id = String(
            block.attachment && block.attachment.attachmentId ? block.attachment.attachmentId : ""
          );
          if (imagePaths.has(id)) {
            targets.push(ev);
            break;
          }
        }
      }
    }
    targets.reverse();
    return targets;
  }

  // Part 3: 只要当前 step 还有「已落盘但未替换」的图片消息，就追加 model-only replace 并 retry。
  ctx.on("agent/request-error", async (payload, next) => {
    if (imagePaths.size === 0) return next();
    const targets = findImageMessages(payload.agent);
    if (targets.length === 0) {
      imagePaths = new Map();
      return next();
    }
    for (const t of targets) {
      const replacement = buildTextVersion(t.data);
      try {
        payload.agent.session.append("user/message", replacement, {
          surfaceOp: { op: "replace", start: t.seq, end: t.seq },
          sourceEventSeqs: [t.seq],
        });
      } catch (err) {
        console.warn("image-bridge: replace failed:", String(err && err.message ? err.message : err));
      }
    }
    imagePaths = new Map();
    return { kind: "retry" };
  });
}

export { apply, inject, name };
