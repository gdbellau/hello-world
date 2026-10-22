import { validateSetting, type SettingDef, type SettingValue } from "../../../shared/settings";
import { buildExport, diffImport, parseImport, type ImportDiff } from "../../../worker/admin-lib";
import { api, esc, ago, download, post, toast, when } from "../ui";

interface SettingsResp {
  schema: SettingDef[];
  values: Record<string, SettingValue>;
  overrides: { key: string; updated_at: number; updated_by: string }[];
}

const view = { q: "", modified: false, cat: "" };
let who = "";
export const setWho = (email: string) => (who = email);

const fmtVal = (d: SettingDef, v: SettingValue) => (d.type === "boolean" ? (v ? "on" : "off") : d.type === "string" ? (v === "" ? "(empty)" : String(v)) : String(v));
const slug = (c: string) => c.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function control(d: SettingDef, v: SettingValue): string {
  const id = `s-${d.key}`;
  if (d.type === "boolean")
    return `<label class="switch"><input type="checkbox" id="${id}" data-key="${d.key}" ${v ? "checked" : ""}><span aria-hidden="true"></span><span class="sr">${esc(d.label)}</span></label>`;
  if (d.type === "string")
    return String(v).length > 60 || d.key === "motd"
      ? `<textarea id="${id}" data-key="${d.key}" rows="2" maxlength="2000" aria-label="${esc(d.label)}">${esc(v)}</textarea>`
      : `<input type="text" id="${id}" data-key="${d.key}" value="${esc(v)}" maxlength="2000" aria-label="${esc(d.label)}">`;
  return `<input type="number" id="${id}" data-key="${d.key}" value="${esc(v)}" aria-label="${esc(d.label)}"
    ${d.min !== undefined ? `min="${d.min}"` : ""} ${d.max !== undefined ? `max="${d.max}"` : ""} step="${d.type === "integer" ? 1 : "any"}">`;
}

function readControl(d: SettingDef, el: HTMLInputElement | HTMLTextAreaElement): unknown {
  if (d.type === "boolean") return (el as HTMLInputElement).checked;
  if (d.type === "string") return el.value;
  return el.value.trim() === "" ? NaN : Number(el.value);
}

export async function renderSettings(main: HTMLElement): Promise<void> {
  const s = await api<SettingsResp>("/settings");
  const ov = new Map(s.overrides.map((o) => [o.key, o]));
  const cats = [...new Set(s.schema.map((d) => d.category))];
  const dirty = new Map<string, SettingValue>();
  const invalid = new Set<string>();

  main.innerHTML = `
    <div class="toolbar">
      <h1>Settings</h1>
      <span class="dim">${s.schema.length} settings · ${ov.size} overridden</span>
      <span class="push"></span>
      <button type="button" class="ghost sm" data-export>Export JSON</button>
      <button type="button" class="ghost sm" data-import>Import JSON…</button>
    </div>
    <div class="filters">
      <input type="search" data-q placeholder="Filter by name, key or description" value="${esc(view.q)}" aria-label="Filter settings">
      <label class="check"><input type="checkbox" data-mod ${view.modified ? "checked" : ""}> Modified only</label>
    </div>
    <div class="settings-layout">
      <nav class="catnav" aria-label="Categories">${cats
        .map((c) => {
          const defs = s.schema.filter((d) => d.category === c);
          const m = defs.filter((d) => ov.has(d.key)).length;
          return `<a href="#settings" data-cat="${esc(c)}"><span>${esc(c)}</span><span class="dim">${m ? `<b class="modc">${m}</b> / ` : ""}${defs.length}</span></a>`;
        })
        .join("")}</nav>
      <div class="settings-list">${cats
        .map(
          (c) => `<section class="cat card" data-section="${esc(c)}" id="cat-${slug(c)}"><h2>${esc(c)}</h2>${s.schema
            .filter((d) => d.category === c)
            .map((d) => {
              const o = ov.get(d.key);
              const range = d.min !== undefined || d.max !== undefined ? ` · range ${d.min ?? "–∞"} to ${d.max ?? "∞"}` : "";
              return `<div class="setting${o ? " modified" : ""}" data-row="${d.key}" data-text="${esc(`${d.label} ${d.key} ${d.description} ${d.category}`.toLowerCase())}">
                <div class="meta">
                  <label for="s-${d.key}"><b>${esc(d.label)}</b></label> <code class="key">${d.key}</code>
                  ${d.public ? "" : '<span class="tag">server-only</span>'}${o ? '<span class="tag mod">modified</span>' : ""}
                  <div class="dim">${esc(d.description)}</div>
                  <div class="dim">Default <code>${esc(fmtVal(d, d.default))}</code>${o ? ` · current <code>${esc(fmtVal(d, s.values[d.key]!))}</code>` : ""}${range}</div>
                  ${o ? `<div class="dim">Changed by ${esc(o.updated_by)} · <span title="${esc(when(o.updated_at))}">${esc(ago(o.updated_at))}</span></div>` : ""}
                </div>
                <div class="ctl">${control(d, s.values[d.key]!)}<div class="verr" role="alert"></div></div>
                <div class="btns">
                  <button type="button" class="sm" data-save="${d.key}" disabled>Save</button>
                  ${o ? `<button type="button" class="ghost sm" data-reset="${d.key}">Reset</button>` : ""}
                </div>
              </div>`;
            })
            .join("")}</section>`,
        )
        .join("")}<p class="empty" data-none hidden>No settings match.</p></div>
    </div>
    <div class="savebar" data-savebar hidden>
      <span data-dirtycount></span>
      <button type="button" class="ghost sm" data-discard>Discard</button>
      <button type="button" class="sm" data-saveall>Save all</button>
    </div>`;

  const def = (k: string) => s.schema.find((d) => d.key === k)!;

  const applyFilter = () => {
    const q = view.q.trim().toLowerCase();
    let any = false;
    main.querySelectorAll<HTMLElement>("[data-section]").forEach((sec) => {
      let n = 0;
      sec.querySelectorAll<HTMLElement>("[data-row]").forEach((r) => {
        const show = (!q || r.dataset.text!.includes(q)) && (!view.modified || ov.has(r.dataset.row!) || dirty.has(r.dataset.row!));
        r.hidden = !show;
        if (show) n++;
      });
      sec.hidden = n === 0;
      any ||= n > 0;
    });
    main.querySelector<HTMLElement>("[data-none]")!.hidden = any;
  };

  const updateBar = () => {
    const bar = main.querySelector<HTMLElement>("[data-savebar]")!;
    bar.hidden = dirty.size === 0 && invalid.size === 0;
    main.querySelector("[data-dirtycount]")!.textContent =
      `${dirty.size} unsaved change${dirty.size === 1 ? "" : "s"}` + (invalid.size ? ` · ${invalid.size} invalid` : "");
    main.querySelector<HTMLButtonElement>("[data-saveall]")!.disabled = invalid.size > 0 || dirty.size === 0;
  };

  // Inline validation with the shared schema, as the Worker will do.
  main.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-key]").forEach((el) => {
    const key = el.dataset.key!;
    const d = def(key);
    const row = el.closest<HTMLElement>("[data-row]")!;
    const err = row.querySelector<HTMLElement>(".verr")!;
    const save = row.querySelector<HTMLButtonElement>("[data-save]")!;
    const check = () => {
      let v: SettingValue | null = null;
      try {
        v = validateSetting(key, readControl(d, el));
        err.textContent = "";
        el.removeAttribute("aria-invalid");
      } catch (e) {
        err.textContent = (e as Error).message;
        el.setAttribute("aria-invalid", "true");
      }
      const changed = v !== null && v !== s.values[key];
      save.disabled = !changed;
      row.classList.toggle("dirty", changed || v === null);
      if (changed) dirty.set(key, v!);
      else dirty.delete(key);
      if (v === null) invalid.add(key);
      else invalid.delete(key);
      updateBar();
    };
    el.addEventListener("input", check);
    el.addEventListener("change", check);
  });

  const saveOne = async (key: string, value: SettingValue) => {
    await post("/settings", { key, value }, "PUT");
  };
  main.querySelectorAll<HTMLButtonElement>("[data-save]").forEach(
    (b) =>
      (b.onclick = async () => {
        const key = b.dataset.save!;
        if (!dirty.has(key)) return;
        try {
          await saveOne(key, dirty.get(key)!);
          toast(`Saved ${key}`);
          document.dispatchEvent(new CustomEvent("settings-changed"));
          void renderSettings(main);
        } catch (e) {
          toast((e as Error).message, true);
        }
      }),
  );
  main.querySelectorAll<HTMLButtonElement>("[data-reset]").forEach(
    (b) =>
      (b.onclick = async () => {
        const key = b.dataset.reset!;
        if (!confirm(`Reset ${key} to its default (${fmtVal(def(key), def(key).default)})?`)) return;
        try {
          await api(`/settings/${key}`, { method: "DELETE" });
          toast(`Reset ${key}`);
          document.dispatchEvent(new CustomEvent("settings-changed"));
          void renderSettings(main);
        } catch (e) {
          toast((e as Error).message, true);
        }
      }),
  );
  main.querySelector<HTMLButtonElement>("[data-saveall]")!.onclick = async () => {
    try {
      const r = await post<{ applied: number }>("/settings/batch", { values: Object.fromEntries(dirty), reason: "bulk edit" });
      toast(`Saved ${r.applied} setting${r.applied === 1 ? "" : "s"}`);
      document.dispatchEvent(new CustomEvent("settings-changed"));
      void renderSettings(main);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  main.querySelector<HTMLButtonElement>("[data-discard]")!.onclick = () => void renderSettings(main);

  const q = main.querySelector<HTMLInputElement>("[data-q]")!;
  q.oninput = () => {
    view.q = q.value;
    applyFilter();
  };
  main.querySelector<HTMLInputElement>("[data-mod]")!.onchange = (e) => {
    view.modified = (e.target as HTMLInputElement).checked;
    applyFilter();
  };
  main.querySelectorAll<HTMLAnchorElement>("[data-cat]").forEach(
    (a) =>
      (a.onclick = (e) => {
        e.preventDefault();
        main.querySelector(`#cat-${slug(a.dataset.cat!)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }),
  );
  main.querySelector<HTMLButtonElement>("[data-export]")!.onclick = () => {
    download(`cabal-settings-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(buildExport(s.values, who), null, 2));
  };
  main.querySelector<HTMLButtonElement>("[data-import]")!.onclick = () => importDialog(s, () => void renderSettings(main));
  applyFilter();
}

function diffHtml(d: ImportDiff, schema: SettingDef[]): string {
  const byKey = new Map(schema.map((x) => [x.key, x]));
  const f = (k: string, v: SettingValue) => esc(fmtVal(byKey.get(k)!, v));
  return `
    <p><b>${d.changes.length}</b> change${d.changes.length === 1 ? "" : "s"} · ${d.unchanged.length} unchanged · ${d.unknown.length} unknown · ${d.errors.length} invalid</p>
    ${d.errors.length ? `<div class="callout bad"><b>Invalid values block the import:</b><ul>${d.errors.map((e) => `<li><code>${esc(e.key)}</code>: ${esc(e.error)}</li>`).join("")}</ul></div>` : ""}
    ${d.unknown.length ? `<div class="callout"><b>Skipped (not in this build's schema):</b> ${d.unknown.map((k) => `<code>${esc(k)}</code>`).join(" ")}</div>` : ""}
    ${
      d.changes.length
        ? `<div class="scroll"><table class="data"><thead><tr><th>Setting</th><th>Current</th><th></th><th>Imported</th></tr></thead><tbody>${d.changes
            .map(
              (c) => `<tr><td>${esc(c.label)}<div class="dim"><code>${esc(c.key)}</code> · ${esc(c.category)}</div></td>
              <td><del>${f(c.key, c.from)}</del></td><td aria-hidden="true">→</td><td><ins>${f(c.key, c.to)}</ins>${c.action === "reset" ? ' <span class="tag">default</span>' : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : ""
    }`;
}

function importDialog(s: SettingsResp, done: () => void): void {
  const d = document.createElement("dialog");
  d.className = "dlg wide";
  d.innerHTML = `<form method="dialog">
    <h3>Import settings</h3>
    <p class="dim">Paste an export (or a flat <code>{"key": value}</code> object) or choose a file. Nothing changes until you apply.</p>
    <input type="file" accept="application/json,.json" data-file aria-label="Settings JSON file">
    <textarea rows="4" data-imptext placeholder='{"format":"cabal-settings","values":{…}}' aria-label="Settings JSON"></textarea>
    <div data-diff class="diffbox"></div>
    <label for="imp-reason">Reason (audit-logged)</label>
    <input id="imp-reason" data-reason placeholder="e.g. copy balance from staging">
    <p class="err" role="alert" hidden></p>
    <div class="row end">
      <button type="button" class="ghost" data-cancel>Cancel</button>
      <button type="button" class="ghost" data-preview>Preview diff</button>
      <button type="submit" data-apply disabled>Apply</button>
    </div></form>`;
  document.body.append(d);
  const text = d.querySelector<HTMLTextAreaElement>("[data-imptext]")!;
  const err = d.querySelector<HTMLElement>(".err")!;
  const apply = d.querySelector<HTMLButtonElement>("[data-apply]")!;
  let parsed: Record<string, unknown> | null = null;
  const close = () => {
    d.close();
    d.remove();
  };
  const preview = () => {
    err.hidden = true;
    apply.disabled = true;
    try {
      parsed = parseImport(text.value);
      const diff = diffImport(s.schema, s.values, parsed);
      d.querySelector("[data-diff]")!.innerHTML = diffHtml(diff, s.schema);
      apply.disabled = diff.errors.length > 0 || diff.changes.length === 0;
      apply.textContent = `Apply ${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"}`;
    } catch (e) {
      parsed = null;
      d.querySelector("[data-diff]")!.innerHTML = "";
      err.textContent = (e as Error).message;
      err.hidden = false;
    }
  };
  d.querySelector<HTMLInputElement>("[data-file]")!.onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) {
      text.value = await f.text();
      preview();
    }
  };
  text.oninput = () => (apply.disabled = true);
  d.querySelector<HTMLButtonElement>("[data-preview]")!.onclick = preview;
  d.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = close;
  d.addEventListener("cancel", close);
  d.querySelector("form")!.onsubmit = async (e) => {
    e.preventDefault();
    if (!parsed) return;
    apply.disabled = true;
    try {
      const r = await post<{ applied: number }>("/settings/batch", { values: parsed, reason: d.querySelector<HTMLInputElement>("[data-reason]")!.value || "import" });
      toast(`Imported ${r.applied} change${r.applied === 1 ? "" : "s"}`);
      document.dispatchEvent(new CustomEvent("settings-changed"));
      close();
      done();
    } catch (ex) {
      err.textContent = (ex as Error).message;
      err.hidden = false;
      apply.disabled = false;
    }
  };
  d.showModal();
}
