// Tạo bài hát trên Suno trong chính tab của bạn. Bộ chọn và luật nhận diện tình huống nằm ở đầu file để chỉnh khi Suno đổi giao diện.
/* global AA, chrome */
(() => {
  if (window.__aaSuno) return;
  window.__aaSuno = true;

  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const RE = {
    loggedOut: /^(log in|sign in|join suno.*|sign up.*)$/i,
    advanced: /^(advanced|custom)$/i,
    create: /^create(\s|$)/i,
    instrumental: /instrumental/i,
    againIn: /again in\s*([\d:]+)/i,
  };
  const CAPTCHA_FRAME = 'iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[title*="captcha" i]';

  // Các tình huống Suno có thể chặn việc tạo nhạc. Thứ tự quan trọng: khớp luật đầu tiên.
  //  fatal = dừng và báo lý do · user = chờ bạn xử lý trong tab · wait = chờ rồi thử tiếp · dismiss = đóng hộp thoại phụ
  const RULES = [
    { kind: "limit", action: "fatal", re: /out of (songs|credits)|you can create again in|not enough credits|(reached|hit) (your|the) .{0,30}(limit|quota)|upgrade to (keep|continue)|no credits|hết credit|hết lượt|hết bài|hết tín dụng|không đủ tín dụng|không có đủ tín dụng/i },
    { kind: "captcha", action: "user", re: /captcha|verify you are human|i['’]?m not a robot|are you a robot/i },
    { kind: "login", action: "user", re: /ready to make music|log in to (create|continue)|sign in to (create|continue)|session (has )?expired|please (log|sign) in/i },
    { kind: "verify", action: "user", re: /verify (your )?(phone|email|age|identity|account)|confirm your age|accept (the )?(terms|policy)|terms of (service|use)|date of birth/i },
    { kind: "moderation", action: "fatal", re: /(lyrics|prompt|style|title|artist).{0,100}(not allowed|can['’]?t be used|cannot be used|violat|inappropriate|moderat|policy|blocked|restricted|banned)|copyright|artist names? (are|is) not/i },
    { kind: "toolong", action: "fatal", re: /too long|exceeds? .{0,20}(limit|characters)|maximum .{0,20}characters/i },
    { kind: "busy", action: "wait", re: /too many (requests|songs|generations)|slow down|already (generating|creating)|maximum .{0,30}(concurrent|at once)|try again in a (moment|few)/i },
    { kind: "error", action: "fatal", re: /something went wrong|failed to (create|generate)|generation failed|an error occurred|unable to (create|generate)|try again later/i },
  ];

  const MESSAGE = {
    limit: (t) => `Suno báo hết lượt tạo nhạc${t ? `, tạo lại được sau ${t}` : ""}. Hãy thử lại sau, hoặc nâng cấp gói Suno.`,
    moderation: (_t, raw) => `Suno từ chối nội dung (lời, phong cách hoặc tên vi phạm quy định, hoặc nhắc tên nghệ sĩ có bản quyền). Hãy sửa lại rồi thử lại. Suno nói: "${raw}"`,
    toolong: (_t, raw) => `Nội dung quá dài so với giới hạn của Suno: "${raw}"`,
    error: (_t, raw) => `Suno báo lỗi: "${raw}"`,
  };

  const loggedOut = () => !!AA.findButton(RE.loggedOut) || /sign-in|login/.test(location.pathname);
  const captchaFrame = () => [...document.querySelectorAll(CAPTCHA_FRAME)].some(AA.visible);
  const songIds = () => [...new Set([...document.querySelectorAll("a[href*='/song/']")].map((a) => a.getAttribute("href").match(UUID)?.[0]?.toLowerCase()).filter(Boolean))];
  const createButton = () => AA.buttons().filter((b) => RE.create.test(AA.text(b))).pop();

  /** Hàng chứa bài hát: đi lên từ link /song/<id> tới phần tử có hiện thời lượng (m:ss) */
  function songRow(id) {
    let el = document.querySelector(`a[href*='${id}']`);
    for (let i = 0; el && i < 8; i++, el = el.parentElement) {
      if (/\b\d{1,2}:\d{2}\b/.test(AA.text(el)) || /generating|queued|creating|processing/i.test(AA.text(el))) return el;
    }
    return null;
  }

  /** Bài đã render xong khi hàng hiện thời lượng và không còn chữ đang tạo */
  function isRendered(id) {
    const row = songRow(id);
    if (!row) return false;
    const t = AA.text(row);
    return /\b\d{1,2}:\d{2}\b/.test(t) && !/generating|queued|creating|processing/i.test(t);
  }

  function isJwtValid(token) {
    if (!token || typeof token !== "string") return false;
    try {
      const raw = token.replace(/^Bearer\s+/i, "").trim();
      const parts = raw.split(".");
      if (parts.length !== 3) return false;
      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      return typeof payload.exp === "number" && payload.exp * 1000 > Date.now() + 5000;
    } catch {
      return false;
    }
  }

  /** Phiên đăng nhập Suno còn hạn mới nhất trong cookie "__session*" (Suno làm mới mỗi phút; có thể còn cookie cũ đã hết hạn) */
  function sessionFromCookie() {
    let best = null;
    for (const c of document.cookie.split(";")) {
      const [name, ...rest] = c.trim().split("=");
      if (!/^__session(_.+)?$/.test(name)) continue;
      const jwt = rest.join("=");
      try {
        const { exp } = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        if (exp * 1000 > Date.now() + 5000 && (!best || exp > best.exp)) best = { jwt, exp };
      } catch {
        /* không phải JWT */
      }
    }
    return best?.jwt ?? null;
  }

  async function getSunoToken() {
    // 0. Cookie phiên của Suno trong document.cookie
    const fromCookie = sessionFromCookie();
    if (fromCookie && isJwtValid(fromCookie)) return fromCookie;

    // 1. Thử lấy từ background (đọc qua chrome.cookies, lấy được cả HttpOnly cookie)
    try {
      const res = await AA.send({ type: "getSunoToken" });
      if (res?.token && isJwtValid(res.token)) return res.token;
    } catch {}

    // 2. Thử lấy từ context trang web thông qua script injection
    try {
      const channel = "suno_token_" + Math.random().toString(36).slice(2);
      const token = await new Promise((resolve) => {
        const handler = (e) => {
          if (e.data && e.data.channel === channel) {
            window.removeEventListener("message", handler);
            resolve(e.data.token || null);
          }
        };
        window.addEventListener("message", handler);
        const script = document.createElement("script");
        script.textContent = `
          (async () => {
            try {
              let t = null;
              if (window.Clerk && window.Clerk.session) {
                t = await window.Clerk.session.getToken();
              }
              window.postMessage({ channel: "${channel}", token: t }, "*");
            } catch (err) {
              window.postMessage({ channel: "${channel}", token: null }, "*");
            }
          })();
        `;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
        setTimeout(() => {
          window.removeEventListener("message", handler);
          resolve(null);
        }, 3000);
      });

      if (token && isJwtValid(token)) {
        await AA.send({ type: "setSunoToken", token }).catch(() => {});
        return token;
      }
    } catch {}

    return null;
  }

  async function resolveSunoDownloadUrl(id, ctx) {
    const token = await getSunoToken();
    const authHeader = token ? (token.startsWith("Bearer ") ? token : `Bearer ${token}`) : undefined;

    let denied = null;
    for (let round = 0; round < 15; round++) {
      try {
        const res = await fetch(`https://studio-api-prod.suno.com/api/download/clip/${id}?format=mp3`, {
          credentials: "include",
          headers: {
            ...(authHeader ? { Authorization: authHeader } : {}),
            Accept: "application/json",
          },
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.download_url && data?.status === "ready") {
            return data.download_url;
          }
          if (data?.status === "processing") {
            await ctx.beat("Suno đang kết xuất file MP3…");
            await AA.sleep(2000);
            continue;
          }
          // Suno từ chối (vd: not_authorized / no permission)
          if (data?.ok === false) {
            denied = data;
            break;
          }
        } else if (res.status === 401 || res.status === 403) {
          denied = { message: `Yêu cầu quyền truy cập (HTTP ${res.status})` };
          break;
        }
      } catch {}
      await AA.sleep(2000);
    }
    if (denied) {
      ctx.lastDownloadError = String(denied.message || denied.reason || "").slice(0, 160);
      return null;
    }
    return null;
  }

  /** Địa chỉ file nhạc: ưu tiên API download chính thức của Suno, tránh stream mã hóa */
  async function findAudioUrl(id, ctx) {
    // 1. Thử lấy link tải MP3 chính thức qua API có xác thực của Suno
    try {
      await ctx.say("Đang lấy link tải MP3 chính thức từ Suno…");
      const officialMp3 = await resolveSunoDownloadUrl(id, ctx);
      if (officialMp3) return officialMp3;
    } catch {}

    // 2. Thử đọc trang bài hát
    try {
      const pageInfo = await readSongPage(id);
      if (pageInfo.audioUrl) return pageInfo.audioUrl;
    } catch {}

    // 3. Thử link cdn1 công khai
    try {
      const mp3 = `https://cdn1.suno.ai/${id}.mp3`;
      if ((await AA.send({ type: "head", url: mp3 })).ok) return mp3;
    } catch {}

    // 4. Thử kích hoạt tải qua menu 3 chấm trên giao diện bài hát
    try {
      const row = songRow(id) || document;
      const directDownloadBtn = row.querySelector("button[aria-label*='download' i], button[title*='download' i], button[aria-label*='tải' i]");
      let triggerBtn = directDownloadBtn;
      if (!triggerBtn) {
        triggerBtn = row.querySelector("button[aria-haspopup='menu'], button[aria-label*='more' i], button[aria-label*='action' i]");
      }
      if (triggerBtn) {
        triggerBtn.click();
        await AA.sleep(1000);
        const menuItems = Array.from(document.querySelectorAll("[role='menuitem'], button"));
        const downloadItem = menuItems.find((el) => /download|tải/i.test(AA.text(el)));
        if (downloadItem) {
          downloadItem.click();
          await AA.sleep(1000);
          const subItems = Array.from(document.querySelectorAll("[role='menuitem'], button"));
          const mp3Item = subItems.find((el) => /mp3|audio/i.test(AA.text(el))) || downloadItem;
          if (mp3Item && mp3Item !== downloadItem) {
            mp3Item.click();
          }
          await AA.sleep(3000);
          const captured = await AA.send({ type: "getCapturedAudio" });
          if (captured?.url && !captured.url.includes("/1/clip/")) {
            return captured.url;
          }
        }
        document.body.click();
      }
    } catch {}

    return null;
  }

  /** Nút Create đổi thành "Create again in 14:04:16" khi hết lượt */
  function limitFromButton() {
    const m = createButton() && AA.text(createButton()).match(RE.againIn);
    return m ? m[1] : null;
  }

  /** Quét hộp thoại/thông báo đang hiện. Trả về null nếu không có gì chặn. */
  function currentBlock() {
    const waitTime = limitFromButton();
    if (waitTime) return { rule: RULES[0], text: "", waitTime };
    if (captchaFrame()) return { rule: RULES[1], text: "" };
    const items = AA.overlayTexts();
    const hit = AA.matchRules(RULES, items);
    if (!hit) return null;
    return { rule: hit.rule, text: hit.item.text, el: hit.item.el, waitTime: hit.item.text.match(/(\d{1,2}:\d{2}:\d{2})/)?.[1] };
  }

  const USER_PROMPT = {
    captcha: "Suno yêu cầu captcha. Hãy giải ngay trong tab này, tiện ích sẽ chạy tiếp.",
    login: "Suno yêu cầu đăng nhập. Hãy đăng nhập ngay trong tab này, tiện ích sẽ chạy tiếp.",
    verify: "Suno yêu cầu xác minh hoặc đồng ý điều khoản. Hãy làm ngay trong tab này, tiện ích sẽ chạy tiếp.",
  };

  /**
   * Xử lý tình huống chặn nếu có: dừng việc (fatal), chờ bạn làm (user), hoặc chờ rồi tiếp (wait).
   * Gọi ở mọi bước quan trọng và trong các vòng chờ.
   */
  async function guard(ctx) {
    for (let round = 0; round < 40; round++) {
      const block = currentBlock();
      if (!block) return;
      const { rule, text, waitTime } = block;
      if (rule.action === "fatal") {
        const raw = text.slice(0, 160);
        throw new AA.Blocked((MESSAGE[rule.kind] ?? MESSAGE.error)(waitTime, raw));
      }
      if (rule.action === "user") {
        await ctx.needUser(USER_PROMPT[rule.kind]);
        const cleared = await AA.waitFor(() => !currentBlock() || currentBlock().rule.kind !== rule.kind, {
          timeoutMs: 15 * 60_000,
          stepMs: 2500,
          onTick: () => ctx.beat(USER_PROMPT[rule.kind], "needs_user"),
        });
        if (!cleared) throw new AA.Blocked(`Hết thời gian chờ bạn xử lý (${rule.kind}) trên Suno`);
        await ctx.say("Đã xử lý xong, tiếp tục");
        continue;
      }
      // wait: Suno đang bận, chờ rồi kiểm tra lại
      await ctx.beat("Suno đang bận, chờ một chút…");
      await AA.sleep(15_000);
    }
    throw new AA.Blocked("Suno vẫn báo bận sau nhiều lần chờ. Hãy thử lại sau.");
  }

  /** Đóng quảng cáo hay hộp giới thiệu không nằm trong luật chặn, để không che nút */
  function dismissExtras() {
    for (const o of AA.overlayTexts()) if (!AA.matchRules(RULES, [o])) AA.dismiss(o.el);
  }

  async function navigate(url) {
    location.href = url;
    await AA.sleep(60_000); // trang sẽ tải lại, tiện ích tự chạy tiếp ở trang mới
  }

  async function ensureLoggedIn(ctx) {
    await AA.sleep(2500);
    if (!loggedOut()) return;
    await ctx.needUser(USER_PROMPT.login);
    const ok = await AA.waitFor(() => !loggedOut(), { timeoutMs: 15 * 60_000, stepMs: 2500, onTick: () => ctx.beat(USER_PROMPT.login, "needs_user") });
    if (!ok) throw new AA.Blocked("Hết thời gian chờ đăng nhập Suno");
    await ctx.say("Đã đăng nhập Suno");
  }

  async function readSongPage(id) {
    try {
      const html = await (await fetch(`/song/${id}`, { credentials: "include" })).text();
      const title = (
        html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? ""
      )
        .replace(/\s*\|\s*Suno.*$/i, "")
        .trim();

      // Trích xuất audio URL (CloudFront .m4a / .mp3)
      let audioUrl = null;
      const cfMatches = [...html.matchAll(/(https:\/\/[^"\\s]*cloudfront\.net\/[^"\\s]+)/g)].map((m) => m[1]);
      for (const u of cfMatches) {
        const clean = u.replace(/\\u0026/g, "&").replace(/\\+$/g, "");
        if (clean.includes("/1/clip/") || clean.includes("m4a-opus")) continue;
        if (clean.includes(id) || clean.endsWith(".m4a") || clean.endsWith(".mp3")) {
          audioUrl = clean;
          break;
        }
      }

      // Trích xuất lời bài hát (hỗ trợ cả React Server Components references và chuỗi thông thường)
      let lyrics = "";
      const idPattern = `"${id}"`;
      const songPos = html.indexOf(idPattern);
      if (songPos !== -1) {
        const chunk = html.slice(songPos, songPos + 5000);
        const promptMatch = chunk.match(/\\?"prompt\\?":\\?"([^"\\]*)\\?"/);
        if (promptMatch) {
          const rawPrompt = promptMatch[1];
          if (rawPrompt.startsWith("$")) {
            const refId = rawPrompt.slice(1);
            const refRegex = new RegExp(`(?:^|[\\r\\n]|\\\\n)${refId}:T([0-9a-fA-F]+),`);
            const refMatch = html.match(refRegex);
            if (refMatch && refMatch.index !== undefined) {
              const commaIdx = html.indexOf(",", refMatch.index);
              if (commaIdx !== -1) {
                const hexLen = refMatch[1];
                const byteLen = parseInt(hexLen, 16);
                if (byteLen > 0 && byteLen < 50000) {
                  lyrics = html
                    .slice(commaIdx + 1, commaIdx + 1 + byteLen)
                    .replace(/\\\\n/g, "\n")
                    .replace(/\\n/g, "\n")
                    .replace(/\\"/g, '"');
                }
              }
            }
          } else {
            lyrics = rawPrompt.replace(/\\\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\"/g, '"');
          }
        }
      }

      return {
        title: title.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'"),
        lyrics: lyrics.slice(0, 20000),
        audioUrl,
      };
    } catch {
      return { title: "", lyrics: "", audioUrl: null };
    }
  }

  async function createSong(ctx) {
    if (ctx.job.payload?.action === "fetch_audio" && ctx.job.payload?.sunoId) {
      const id = ctx.job.payload.sunoId;
      await ctx.say("Đang kết nối tới bài hát trên Suno…");

      // Nếu tab hiện tại chưa mở trang bài hát này, điều hướng để Suno làm mới phiên và render giao diện
      if (!location.pathname.includes(id)) {
        await navigate(`https://suno.com/song/${id}`);
        await AA.sleep(2500);
      }

      let audioUrl = await findAudioUrl(id, ctx);
      const info = await readSongPage(id);
      const result = {
        sunoUrl: `https://suno.com/song/${id}`,
        sunoId: id,
        title: info.title || ctx.job.payload.title || "",
        lyrics: info.lyrics || "",
      };
      if (audioUrl) {
        await ctx.say("Đang tải file MP3 về hệ thống…");
        const ext = audioUrl.includes(".m4a") ? "m4a" : "mp3";
        const saved = await AA.send({
          type: "fetchUpload",
          jobId: ctx.job.id,
          url: audioUrl,
          name: `${result.title || id}.${ext}`,
        });
        result.audioAssetId = saved.assetId;
        if (saved.durationSec) result.durationSec = saved.durationSec;
      } else {
        const reason = ctx.lastDownloadError;
        const msg = reason
          ? `Suno không cho tải bài này tự động ("${reason}"). Bạn có thể mở bài trên Suno, tải file MP3 về máy rồi kéo thả vào ô "Tải file MP3" để gắn vào bài.`
          : "Chưa lấy được file MP3 tự động từ Suno. Bạn hãy mở trang bài trên Suno rồi tải file MP3 lên Kho.";
        throw new Error(msg);
      }
      return result;
    }

    const { title, style, lyrics, instrumental } = ctx.job.payload;
    let state = (await ctx.getState()) ?? {};

    if (state.phase !== "created") {
      if (!/\/create/.test(location.pathname)) {
        await ensureLoggedIn(ctx);
        if (!/\/create/.test(location.pathname)) return navigate("https://suno.com/create");
      }
      await ensureLoggedIn(ctx);
      dismissExtras();
      await guard(ctx); // đã hết lượt hoặc có hộp thoại chặn thì dừng ngay, không điền vô ích

      await ctx.say("Đang điền thông tin bài hát");
      let fields = AA.classify(AA.textFields());
      if (!fields.lyrics || !fields.style) {
        AA.findButton(RE.advanced)?.click();
        await AA.sleep(1200);
        fields = AA.classify(AA.textFields());
      }
      if (!fields.style) throw new Error('Không tìm thấy ô nhập phong cách trên Suno. Mở popup tiện ích, bấm "Lưu cấu trúc trang hiện tại" ở trang Suno rồi gửi cho người hỗ trợ.');
      if (lyrics && !instrumental) {
        // Có lời mà không điền được thì không bấm Create: nếu không Suno sẽ tạo bản không lời và tốn lượt vô ích
        if (!fields.lyrics) throw new Error('Không tìm thấy ô nhập lời trên Suno nên chưa tạo bài (tránh tốn lượt). Bấm "Lưu cấu trúc trang hiện tại" ở trang Suno rồi gửi cho người hỗ trợ.');
        AA.setValue(fields.lyrics.el, String(lyrics).slice(0, 5000));
        await AA.sleep(300);
        if (!fields.lyrics.el.value.trim()) throw new Error("Không điền được lời vào ô của Suno nên chưa tạo bài (tránh tốn lượt).");
      }
      AA.setValue(fields.style.el, String(style).slice(0, 1000));
      if (fields.title) AA.setValue(fields.title.el, String(title).slice(0, 100));
      if (instrumental) AA.findButton(RE.instrumental)?.click();
      await AA.sleep(700);
      await guard(ctx); // báo lỗi quá dài / bị từ chối ngay khi điền, trước khi bấm

      const before = songIds();
      const create = createButton();
      if (!create || create.disabled) throw new Error('Nút "Create" không bấm được (ô bắt buộc còn trống, hoặc Suno đang khóa). Kiểm tra tab Suno.');
      await ctx.setState({ phase: "created", before });
      await ctx.say("Đang bấm Create");
      create.click();
      await AA.sleep(2000);
      state = { phase: "created", before };
    }

    // Ngay sau khi bấm: popup hết lượt, captcha, nội dung bị từ chối... xuất hiện ở đây
    await guard(ctx);

    await ctx.say("Đang chờ Suno tạo nhạc");
    const before = new Set(state.before ?? []);
    let fresh = [];
    const appeared = await AA.waitFor(
      async () => {
        await guard(ctx);
        fresh = songIds().filter((id) => !before.has(id));
        return fresh.length > 0;
      },
      { timeoutMs: 3 * 60_000, stepMs: 3000, onTick: () => ctx.beat("Đang chờ Suno tạo nhạc") },
    );
    if (!appeared) throw new Error("Không thấy bài mới trên Suno (bài có thể ở trang khác, hoặc Suno chưa nhận yêu cầu). Kiểm tra tab Suno.");

    const id = fresh[0];
    await ctx.say("Đã thấy bài hát mới, đang chờ Suno tạo xong file nhạc…");

    let info = await readSongPage(id);
    let audioUrl = info.audioUrl;

    // Chờ Suno render bài hát (tối đa ~2.5 phút) để lấy được cả file nhạc về web ngay trong phiên
    if (!audioUrl) {
      const waitStart = Date.now();
      while (Date.now() - waitStart < 150_000) {
        await guard(ctx);
        if (isRendered(id)) {
          info = await readSongPage(id);
          if (info.audioUrl) {
            audioUrl = info.audioUrl;
            break;
          }
          audioUrl = await findAudioUrl(id, ctx);
          if (audioUrl) break;
        } else {
          info = await readSongPage(id);
          if (info.audioUrl) {
            audioUrl = info.audioUrl;
            break;
          }
        }
        await ctx.beat("Đang chờ Suno hoàn tất bài nhạc (thường mất 1-2 phút)…");
        await AA.sleep(6000);
      }
    }

    if (!audioUrl) {
      audioUrl = await findAudioUrl(id, ctx);
    }

    const result = {
      sunoUrl: `https://suno.com/song/${id}`,
      sunoId: id,
      title: info.title || title,
      lyrics: info.lyrics || lyrics || "",
    };

    if (audioUrl) {
      await ctx.say("Đang tải file nhạc về web");
      try {
        const ext = audioUrl.includes(".m4a") ? "m4a" : "mp3";
        const saved = await AA.send({
          type: "fetchUpload",
          jobId: ctx.job.id,
          url: audioUrl,
          name: `${result.title || id}.${ext}`,
        });
        result.audioAssetId = saved.assetId;
        if (saved.durationSec) result.durationSec = saved.durationSec;
      } catch (e) {
        await ctx.say(`Chưa tải được file nhạc: ${e.message}`);
      }
    } else {
      result.note = "Đã lấy link bài hát từ Suno. Chờ Suno render xong rồi bấm \"Lấy nhạc về Kho\", hoặc tải MP3 từ Suno rồi tải lên.";
      await ctx.say(result.note);
    }
    return result;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "run" || msg.job?.kind !== "suno_create") return false;
    sendResponse({ ok: true });
    if (window.__aaJob === msg.job.id) return false; // đã đang chạy việc này trong tab
    window.__aaJob = msg.job.id;
    const ctx = AA.context(msg.job);
    (async () => {
      try {
        const result = await createSong(ctx);
        if (result) await AA.send({ type: "done", jobId: msg.job.id, result });
      } catch (e) {
        if (e instanceof AA.Cancelled) return AA.send({ type: "fail", jobId: msg.job.id, error: "Đã hủy" }).catch(() => {});
        await AA.send({ type: "fail", jobId: msg.job.id, error: e.message }).catch(() => {});
      }
    })();
    return false;
  });

  if (typeof module !== "undefined") module.exports = { RULES, MESSAGE };
})();
