window.__ModuleLoader__.load({
  id: "dsh-delete-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /**
     * session-delete — browser half of dsh-delete-plugin.
     *
     * Two sidebar features, both contributed through dsh's own context-menu
     * registry (no DOM scraping of the built-in menus):
     *
     *  1. A danger "Delete session" item on the session row menu. It opens a
     *     risk-consent dialog naming exactly what will be removed, then calls
     *     the host `sessionDelete.deleteSession` RPC and refreshes the list.
     *  2. A "Pin workspace" / "Unpin workspace" item on the workspace row menu.
     *     The host owns a durable pin set; this half surfaces pinned workspaces
     *     ahead of the rest (self-healing order via workspace.insertBefore) and
     *     paints a small pin badge on pinned workspace headers.
     *
     * The host call goes through the api-gateway remote namespace mounted below
     * (`ctx.get('remote.sessionDelete')`), published by the host half as a Typert
     * Remote service.
     */

    // Client contribution for the `sessionDelete` Remote namespace. The host is
    // discovered by the api-gateway through SRC, so the client only needs strict
    // descriptors with identity codecs. dsh 0.2 requires every strict codec to
    // expose create(); without it the loader refuses the plugin outright.
    function identity(value) { return value }
    const SCHEMA = { parse: identity }
    const CODEC = { mode: "strict", typeSymbol: "dsh-delete-plugin/json", schema: SCHEMA, create: () => SCHEMA }
    function parameter(name) {
      return { name: name, wire: name, source: "json", codec: CODEC }
    }
    function descriptor(method, names) {
      return {
        id: "dsh-delete-plugin#sessionDelete/" + method,
        service: "sessionDelete",
        namespace: "sessionDelete",
        method: method,
        invocation: { kind: "direct" },
        parameters: names.map(parameter),
        result: CODEC,
        sourceLocation: { file: "dsh-delete-plugin/client.js", line: 1, column: 1 }
      }
    }
    const CONTRIBUTION = {
      package: "dsh-delete-plugin",
      descriptors: [
        descriptor("deleteSession", ["sessionId", "platform"]),
        descriptor("getPinnedWorkspaces", []),
        descriptor("pinWorkspace", ["workspaceId"]),
        descriptor("unpinWorkspace", ["workspaceId"])
      ]
    };

    const inject = ["sessions", "workspaces", "remote", "contextMenus"];

    async function apply(ctx) {
      // Mount the client→host remote namespace for the delete + pin calls.
      const disposeRemote = await ctx.remote.$mount(CONTRIBUTION);
      ctx.effect(() => disposeRemote, "dsh-delete-plugin: remote contribution");

      /* ------------------------------------------------------------ *
       * Locale (English / 中文), detected from the document language
       * ------------------------------------------------------------ */
      function detectLang() {
        try {
          const l = document.documentElement.lang || navigator.language || "en";
          return /zh/i.test(l) ? "zh" : "en";
        } catch (error) {
          return "en";
        }
      }
      const LANG = detectLang();
      const L = LANG === "zh" ? {
        delete: "删除会话",
        confirmTitle: "永久删除此会话？",
        confirmBody: "会话“{name}”将被永久删除，包括：\n• 会话日志（聊天记录）\n• 工作区归属记录\n• 运行时会话状态\n此操作无法撤销。",
        cancel: "取消",
        ok: "确定",
        error: "操作失败",
        pinWorkspace: "置顶工作区",
        unpinWorkspace: "取消置顶",
        pinFailed: "置顶失败。"
      } : {
        delete: "Delete session",
        confirmTitle: "Permanently delete this session?",
        confirmBody: "Session “{name}” will be permanently deleted, including:\n• the session log (chat history)\n• its workspace accounting\n• live runtime session state\nThis cannot be undone.",
        cancel: "Cancel",
        ok: "OK",
        error: "Action failed",
        pinWorkspace: "Pin workspace",
        unpinWorkspace: "Unpin workspace",
        pinFailed: "Pin failed."
      };

      /* ------------------------------------------------------------ *
       * Workspace pin set (host-owned), with a tiny observable so the
       * workspace menu re-resolves its label when the set changes
       * ------------------------------------------------------------ */
      let pinSnapshot = [];
      const pinListeners = new Set();
      const pinnedObservable = {
        getSnapshot: () => pinSnapshot,
        subscribe: (listener) => { pinListeners.add(listener); return () => pinListeners.delete(listener); }
      };
      function setPinned(ids) {
        pinSnapshot = Array.isArray(ids) ? ids.slice() : [];
        for (const listener of pinListeners) { try { listener(); } catch (error) { /* ignore */ } }
      }
      const isPinned = (workspaceId) => pinSnapshot.includes(workspaceId);

      function remoteService() {
        // The namespace mounted by $mount lives in another fiber's scope, so it
        // must be read with ctx.get('remote.<ns>').
        return ctx.get("remote.sessionDelete");
      }

      /* ------------------------------------------------------------ *
       * Overlay lifecycle (dialogs self-register disposers)
       * ------------------------------------------------------------ */
      let activeOverlay = null;
      let overlayDisposers = [];
      function closeOverlays() {
        if (activeOverlay) {
          const node = activeOverlay;
          activeOverlay = null;
          if (node.parentNode) node.parentNode.removeChild(node);
        }
        for (const dispose of overlayDisposers.splice(0)) {
          try { dispose(); } catch (error) { console.warn("[dsh-delete] overlay cleanup failed:", error); }
        }
      }
      function registerOverlay(node, disposers) {
        closeOverlays();
        activeOverlay = node;
        overlayDisposers = disposers;
      }
      function overlayStyle() {
        return "position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;";
      }
      function panelStyle() {
        return "min-width:320px;max-width:440px;padding:16px;border-radius:10px;background:var(--dsw-alias-surface-bg,#212126);border:1px solid var(--dsw-alias-border,rgba(128,128,128,.35));box-shadow:0 10px 32px rgba(0,0,0,.5);color:var(--dsw-alias-label-primary,#ececec);font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;";
      }
      function buttonStyle(variant) {
        const base = "padding:7px 14px;border-radius:7px;border:1px solid transparent;cursor:pointer;font:inherit;font-weight:600;";
        if (variant === "danger") return base + "background:#c9423f;color:#fff;";
        if (variant === "primary") return base + "background:var(--dsw-alias-interactive-accent,#3b82f6);color:#fff;";
        return base + "background:var(--dsw-alias-interactive-bg,#2a2a30);color:var(--dsw-alias-label-primary,#ececec);border-color:var(--dsw-alias-border,rgba(128,128,128,.35));";
      }
      function confirmDialog(title, bodyText) {
        return new Promise((resolve) => {
          let settled = false;
          const finish = (value) => { if (settled) return; settled = true; closeOverlays(); resolve(value); };
          const overlay = document.createElement("div");
          overlay.style.cssText = overlayStyle();
          const panel = document.createElement("div");
          panel.style.cssText = panelStyle();
          const h = document.createElement("div");
          h.textContent = title;
          h.style.cssText = "font-size:15px;font-weight:700;margin-bottom:8px;";
          const b = document.createElement("div");
          b.style.cssText = "margin-bottom:16px;word-break:break-word;white-space:pre-wrap;";
          b.textContent = bodyText;
          const row = document.createElement("div");
          row.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.textContent = L.cancel;
          cancel.style.cssText = buttonStyle("outline");
          cancel.addEventListener("click", () => finish(false));
          const ok = document.createElement("button");
          ok.type = "button";
          ok.textContent = L.delete;
          ok.style.cssText = buttonStyle("danger");
          ok.addEventListener("click", () => finish(true));
          row.append(cancel, ok);
          panel.append(h, b, row);
          overlay.append(panel);
          const onKey = (e) => { if (e.key === "Escape") finish(false); };
          document.addEventListener("keydown", onKey, true);
          document.body.appendChild(overlay);
          registerOverlay(overlay, [() => document.removeEventListener("keydown", onKey, true)]);
          ok.focus();
        });
      }
      function alertDialog(message) {
        return new Promise((resolve) => {
          const overlay = document.createElement("div");
          overlay.style.cssText = overlayStyle();
          const panel = document.createElement("div");
          panel.style.cssText = panelStyle();
          const h = document.createElement("div");
          h.textContent = L.error;
          h.style.cssText = "font-size:15px;font-weight:700;margin-bottom:8px;";
          const b = document.createElement("div");
          b.textContent = message;
          b.style.cssText = "margin-bottom:14px;word-break:break-word;white-space:pre-wrap;";
          const ok = document.createElement("button");
          ok.type = "button";
          ok.textContent = L.ok;
          ok.style.cssText = buttonStyle("primary");
          ok.addEventListener("click", () => { closeOverlays(); resolve(); });
          const row = document.createElement("div");
          row.style.cssText = "display:flex;justify-content:flex-end;";
          row.append(ok);
          panel.append(h, b, row);
          overlay.append(panel);
          document.body.appendChild(overlay);
          registerOverlay(overlay, []);
          ok.focus();
        });
      }

      /* ------------------------------------------------------------ *
       * Delete action
       * ------------------------------------------------------------ */
      function browserPlatform() {
        let ua = "";
        try { ua = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ""; } catch (error) { ua = ""; }
        return /win/i.test(ua) ? "win32" : /mac/i.test(ua) || /iphone|ipad/i.test(ua) ? "darwin" : "posix";
      }
      async function safeRefresh() {
        try { await ctx.sessions.refresh(); } catch (error) { console.warn("[dsh-delete] sessions refresh failed:", error); }
        try { if (ctx.workspaces && typeof ctx.workspaces.refresh === "function") await ctx.workspaces.refresh(); } catch (error) { console.warn("[dsh-delete] workspaces refresh failed:", error); }
      }
      async function startDelete(sessionId, title) {
        const name = title && title.length > 0 ? title : sessionId;
        const ok = await confirmDialog(L.confirmTitle, L.confirmBody.replace("{name}", name));
        if (!ok) return;
        let result;
        try {
          const remote = remoteService();
          if (!remote || typeof remote.deleteSession !== "function") throw new Error("remote namespace sessionDelete is not mounted");
          const answered = await remote.deleteSession(sessionId, browserPlatform());
          if (!answered || answered.ok === false) {
            const err = answered && answered.error ? answered.error : { message: "Delete failed." };
            throw new Error((err.code ? err.code + ": " : "") + err.message);
          }
          result = answered.value;
        } catch (error) {
          await alertDialog(error && error.message ? error.message : String(error));
          return;
        }
        if (!result || result.ok === false) {
          const err = result && result.error ? result.error : { message: "Delete failed." };
          await alertDialog((err.code ? err.code + ": " : "") + err.message);
          return;
        }
        const snapshot = ctx.sessions.list.getSnapshot();
        const wasCurrent = snapshot.current === sessionId;
        await safeRefresh();
        if (wasCurrent) {
          const after = ctx.sessions.list.getSnapshot();
          if (after.current === sessionId) {
            if (after.ids.length > 0) ctx.sessions.open(after.ids[0]);
            else ctx.sessions.clear();
          }
        }
      }

      /* ------------------------------------------------------------ *
       * Workspace pin: toggle + self-healing pinned-first order
       * ------------------------------------------------------------ */
      // The api-gateway wraps the host's {ok,value} envelope in its own
      // RemoteResult, so the host envelope sits at answered.value and its
      // payload at answered.value.value. Normalize both layers here.
      function unwrap(answered) {
        if (!answered || answered.ok === false) {
          return { ok: false, error: (answered && answered.error) || { message: "Remote call failed." } };
        }
        const env = answered.value;
        if (!env || env.ok === false) {
          return { ok: false, error: (env && env.error) || { message: "Action failed." } };
        }
        return { ok: true, value: env.value };
      }
      async function togglePin(workspaceId) {
        const remote = remoteService();
        if (!remote) { await alertDialog(L.pinFailed); return; }
        const pinned = isPinned(workspaceId);
        let r;
        try {
          const answered = pinned ? await remote.unpinWorkspace(workspaceId) : await remote.pinWorkspace(workspaceId);
          r = unwrap(answered);
        } catch (error) {
          await alertDialog(error && error.message ? error.message : String(error));
          return;
        }
        if (!r.ok) { await alertDialog((r.error && r.error.message) || L.pinFailed); return; }
        setPinned((r.value && r.value.pinnedWorkspaceIds) || []);
        enforceOrder();
        paintBadges();
      }

      let reordering = false;
      async function enforceOrder() {
        if (reordering) return;
        const items = ctx.workspaces.list.getSnapshot().items;
        const current = items.map((w) => w.workspaceId);
        const present = new Set(current);
        const pinned = pinSnapshot.filter((id) => present.has(id));
        const pinnedSet = new Set(pinned);
        const desired = [...pinned, ...current.filter((id) => !pinnedSet.has(id))];
        if (desired.length === current.length && desired.every((id, i) => id === current[i])) return;
        reordering = true;
        try {
          const order = current.slice();
          for (let i = 0; i < desired.length; i += 1) {
            if (order[i] === desired[i]) continue;
            const j = order.indexOf(desired[i]);
            if (j < 0) continue;
            await ctx.workspaces.insertBefore(desired[i], order[i]);
            order.splice(j, 1);
            order.splice(i, 0, desired[i]);
          }
        } catch (error) {
          console.warn("[dsh-delete] workspace reorder failed:", error);
        } finally {
          reordering = false;
        }
      }

      /* ------------------------------------------------------------ *
       * Pin badge on pinned workspace headers (additive DOM augmentation)
       * ------------------------------------------------------------ */
      const PIN_BADGE_ATTR = "data-dsh-delete-pin-badge";
      // The exact Fluent pin_24_filled glyph dsh uses for the session pin
      // (IconPinFillRegular), so the workspace badge matches it.
      const PIN_SVG =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
        '<path d="M21.0682 7.75765L16.2425 2.93189C14.9152 1.60462 12.6777 1.96772 11.8382 3.6466L9.40281 8.51748C9.31512 8.69287 9.16223 8.82694 8.97688 8.89096L4.81061 10.3302C3.93791 10.6317 3.682 11.7427 4.33487 12.3956L7.43936 15.5001L3.00008 19.9394L3 21.0001H4.06074L8.50002 16.5607L11.6045 19.6653C12.2574 20.3181 13.3684 20.0622 13.6699 19.1895L15.1092 15.0232C15.1732 14.8379 15.3073 14.685 15.4826 14.5973L20.3535 12.1619C22.0324 11.3224 22.3955 9.08491 21.0682 7.75765Z"/></svg>';
      function paintBadges() {
        let rows;
        try { rows = document.querySelectorAll('[data-row-key^="workspace:"]'); } catch (error) { return; }
        const pinnedSet = new Set(pinSnapshot);
        for (const row of rows) {
          const key = row.getAttribute("data-row-key") || "";
          const id = key.slice("workspace:".length);
          const existing = row.querySelector("[" + PIN_BADGE_ATTR + "]");
          if (pinnedSet.has(id)) {
            if (!existing) {
              const badge = document.createElement("span");
              badge.setAttribute(PIN_BADGE_ATTR, "1");
              badge.style.cssText = "display:inline-flex;align-items:center;flex:none;color:var(--dsw-alias-label-secondary,#9aa3b2);";
              badge.innerHTML = PIN_SVG;
              // projectText is a flex column and rowActions is hidden until hover,
              // so attach the badge to the row itself (a flex row): it sits inline
              // at the right and stays visible, like the built-in session pin.
              row.appendChild(badge);
            }
          } else if (existing) {
            existing.remove();
          }
        }
      }
      let badgeScheduled = false;
      function schedulePaint() {
        if (badgeScheduled) return;
        badgeScheduled = true;
        const run = () => { badgeScheduled = false; paintBadges(); };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
        else setTimeout(run, 0);
      }
      let observer = null;
      if (typeof MutationObserver !== "undefined") {
        observer = new MutationObserver(() => schedulePaint());
        observer.observe(document.body, { childList: true, subtree: true });
      }

      /* ------------------------------------------------------------ *
       * Context-menu contributions (dsh's own registry)
       * ------------------------------------------------------------ */
      ctx.effect(() => ctx.contextMenus.register({
        id: "session.deletePermanent",
        target: "session",
        order: 550,
        observe: () => [ctx.sessions.list],
        resolve: (target) => [{
          id: "delete",
          label: L.delete,
          icon: { key: "workspace.delete" },
          danger: true,
          separatorBefore: true,
          run: () => { startDelete(target.sessionId, target.displayTitle); }
        }]
      }), "dsh-delete-plugin: session delete menu");

      ctx.effect(() => ctx.contextMenus.register({
        id: "workspace.pinWorkspace",
        target: "workspace",
        order: 50,
        observe: () => [ctx.workspaces.list, pinnedObservable],
        resolve: (target) => {
          const pinned = isPinned(target.workspaceId);
          return [{
            id: "pin",
            label: pinned ? L.unpinWorkspace : L.pinWorkspace,
            icon: { key: pinned ? "workspace.unpin" : "workspace.pin" },
            run: () => { togglePin(target.workspaceId); }
          }];
        }
      }), "dsh-delete-plugin: workspace pin menu");

      /* ------------------------------------------------------------ *
       * Boot: load the pin set, surface pinned workspaces, paint badges
       * ------------------------------------------------------------ */
      const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(() => { enforceOrder(); schedulePaint(); });
      ctx.effect(() => unsubscribeWorkspaces, "dsh-delete-plugin: workspace order subscription");

      try {
        const remote = remoteService();
        if (remote && typeof remote.getPinnedWorkspaces === "function") {
          const r = unwrap(await remote.getPinnedWorkspaces());
          if (r.ok) setPinned((r.value && r.value.pinnedWorkspaceIds) || []);
        }
      } catch (error) {
        console.warn("[dsh-delete] loading pinned workspaces failed:", error);
      }
      enforceOrder();
      paintBadges();

      /* ------------------------------------------------------------ *
       * Lifecycle: tear everything down on plugin unload
       * ------------------------------------------------------------ */
      ctx.effect(() => () => {
        closeOverlays();
        if (observer) observer.disconnect();
      }, "dsh-delete-plugin: dom cleanup");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});