/** Gig Hub: public feed only. Local signals never enter a request. */
export const TAG_VOCAB = {
  ai: ["人工智能", "机器学习", "llm", "ai"],
  iot: ["物联网", "iot"],
  web: ["网页", "网站", "前端", "后端", "react", "vue", "next.js", "typescript", "javascript", "web"],
  mobile: ["移动端", "小程序", "安卓", "ios", "android", "flutter", "mobile"],
  python: ["python", "py"],
  web3: ["区块链", "blockchain", "solidity", "web3"],
  "3d": ["三维", "建模", "three.js", "blender", "3d"],
  social: ["社交", "社区", "social"],
  global: ["出海", "国际化", "global"],
  games: ["游戏", "game", "unity", "unreal", "games"],
  data: ["数据", "数据分析", "数据科学", "sql", "data"],
  hardware: ["硬件", "嵌入式", "hardware"],
} as const;
export type GigTag = keyof typeof TAG_VOCAB;
const aliases = new Map<string, GigTag>();
for (const id of Object.keys(TAG_VOCAB) as GigTag[]) {
  for (const alias of TAG_VOCAB[id]) aliases.set(alias, id);
}

/** Reject unsafe raw values before normalization; never use substring matching. */
export function normalizeToVocab(values: readonly unknown[]): GigTag[] {
  const tags = new Set<GigTag>();
  for (const value of values) {
    if (typeof value !== "string" || value.length > 16 || /[/\\\s]/u.test(value)) continue;
    const id = aliases.get(value.toLowerCase());
    if (id) tags.add(id);
  }
  return [...tags];
}

export interface Gig {
  gigId: string;
  title: string;
  summary: string;
  tags: GigTag[];
  budgetMin: number;
  budgetMax: number;
  currency: string;
  deadline: string;
}
export interface LocalGigSignals {
  works: readonly { techStack: readonly string[] }[];
  activity: readonly { last_ts: string }[];
}
export interface MatchedGig extends Gig {
  matchScore: number;
  reasons: string[];
}

/** Recommendation relevance only; never a verified capability score. */
export class LocalGigMatcher {
  match(gigs: readonly Gig[], signals: LocalGigSignals, now = Date.now()): MatchedGig[] {
    const localTags = new Set(normalizeToVocab(signals.works.flatMap((work) => [...work.techStack])));
    const recent = signals.activity.some(({ last_ts }) => {
      const age = now - Date.parse(last_ts);
      return age >= 0 && age <= 7 * 24 * 60 * 60 * 1000;
    });
    return gigs.map((gig) => {
      const tags = normalizeToVocab(gig.tags);
      const hits = tags.filter((tag) => localTags.has(tag));
      const reasons: string[] = [];
      if (hits.length) reasons.push(`作品技术栈命中：${hits.join("、")}`);
      if (hits.length && tags.length === hits.length) reasons.push("订单标签与你的技术栈全部匹配");
      if (recent) reasons.push("近 7 天有本地开发活动");
      if (!reasons.length) reasons.push("公开接单机会，可查看需求详情");
      return { ...gig, tags, matchScore: (tags.length ? Math.round(90 * hits.length / tags.length) : 0) + (recent ? 10 : 0), reasons: reasons.slice(0, 3) };
    }).sort((a, b) => b.matchScore - a.matchScore);
  }
}

export const GIG_FEED_URL = "https://hackertrip.space/api/desktop/gigs";
export interface GigFeedSource {
  fetchGigs(signal?: AbortSignal): Promise<Gig[]>;
}

function parseGig(value: unknown): Gig | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.gigId !== "string" || !row.gigId.trim() || row.gigId.length > 256 ||
      typeof row.title !== "string" || !row.title.trim() || row.title.length > 60 ||
      !Array.isArray(row.tags) || typeof row.budgetMin !== "number" ||
      typeof row.budgetMax !== "number" || !Number.isFinite(row.budgetMin) ||
      !Number.isFinite(row.budgetMax) || row.budgetMin < 0 || row.budgetMax < row.budgetMin) return null;
  // Copy the public DTO only. Visibility/review filtering belongs to the public endpoint.
  return {
    gigId: row.gigId, title: row.title,
    summary: typeof row.summary === "string" ? row.summary.slice(0, 120) : "",
    tags: normalizeToVocab(row.tags), budgetMin: row.budgetMin, budgetMax: row.budgetMax,
    currency: typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) ? row.currency : "CNY",
    deadline: typeof row.deadline === "string" ? row.deadline : "",
  };
}

export class RemoteHttpSource implements GigFeedSource {
  async fetchGigs(signal?: AbortSignal): Promise<Gig[]> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 10_000);
    try {
      const response = await fetch(GIG_FEED_URL, {
        method: "GET", credentials: "omit", referrerPolicy: "no-referrer",
        cache: "no-store", redirect: "error", signal: controller.signal,
      });
      if (!response.ok) return [];
      const payload: unknown = await response.json();
      // Accept the public list directly or the documented { ok, data, error } envelope.
      const rows = Array.isArray(payload) ? payload
        : payload && typeof payload === "object" && "ok" in payload && payload.ok === true && "data" in payload
          ? payload.data : null;
      if (!Array.isArray(rows)) return [];
      const seen = new Set<string>();
      return rows.slice(0, 100).flatMap((row: unknown) => {
        const gig = parseGig(row);
        if (!gig || seen.has(gig.gigId)) return [];
        seen.add(gig.gigId);
        return [gig];
      });
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

export interface GigFeedOptions {
  host: HTMLElement;
  settingsHost: HTMLElement;
  store: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void };
  getSignals: () => LocalGigSignals;
  openUrl: (url: string) => Promise<unknown>;
  onChange: () => void;
  source?: GigFeedSource;
}

/** DOM textContent keeps all remote strings inert, including titles and IDs. */
export function renderGigFeed(host: HTMLElement, gigs: readonly MatchedGig[], openUrl: GigFeedOptions["openUrl"]) {
  host.replaceChildren();
  const heading = document.createElement("div");
  heading.className = "section-title";
  heading.textContent = "接单机会";
  host.append(heading);
  if (!gigs.length) {
    const empty = document.createElement("p");
    empty.className = "sub";
    empty.textContent = "暂无可展示的公开订单";
    host.append(empty);
  }
  for (const gig of gigs) {
    const card = document.createElement("article");
    card.className = "dist-card gig-card";
    const title = document.createElement("h3");
    title.className = "dist-title";
    title.textContent = gig.title;
    const budget = document.createElement("p");
    budget.className = "gig-budget mono";
    budget.textContent = `${gig.currency === "CNY" ? "¥" : gig.currency + " "}${gig.budgetMin.toLocaleString("zh-CN")} – ${gig.budgetMax.toLocaleString("zh-CN")}`;
    const tags = document.createElement("div");
    tags.className = "gig-tags";
    for (const tag of gig.tags) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = tag;
      tags.append(badge);
    }
    const reasons = document.createElement("ul");
    reasons.className = "gig-reasons sub";
    for (const reason of gig.reasons.slice(0, 3)) {
      const item = document.createElement("li");
      item.textContent = reason;
      reasons.append(item);
    }
    const button = document.createElement("button");
    button.className = "action";
    button.type = "button";
    button.textContent = "去小程序看看";
    button.addEventListener("click", () => {
      void openUrl(`https://hackertrip.space/gig?id=${encodeURIComponent(gig.gigId)}`).catch(() => {
        button.textContent = "打开失败，点击重试";
      });
    });
    card.append(title, budget, tags, reasons, button);
    host.append(card);
  }
}

export function initGigFeed(options: GigFeedOptions) {
  const { host, settingsHost, store, getSignals, openUrl, onChange } = options;
  const source = options.source ?? new RemoteHttpSource();
  const matcher = new LocalGigMatcher();
  let enabled = store.get<boolean>("gigMode", false) === true;
  let gigs: Gig[] = [];
  let fetchedAt = 0;
  let request: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ttl = 5 * 60 * 1000;
  host.classList.add("gig-feed", "hidden");
  host.setAttribute("aria-label", "接单机会");
  settingsHost.classList.add("gig-settings");
  settingsHost.innerHTML = `<div class="row"><span class="label">接单模式</span><span class="spacer"></span><button type="button" class="action" role="switch" aria-label="接单模式"></button></div><p class="sub">浏览公开订单，在本机匹配；接单匹配不上传本地数据，无需登录。</p>`;
  const toggle = settingsHost.querySelector("button")!;
  const renderToggle = () => {
    toggle.textContent = enabled ? "已开启 · 点击关闭" : "未开启 · 点击开启";
    toggle.setAttribute("aria-checked", String(enabled));
    toggle.classList.toggle("consent-on", enabled);
  };
  const refresh = async () => {
    if (!enabled || request) return;
    clearTimeout(timer);
    const current = new AbortController();
    request = current;
    // Expire old rows before fetching so failed refreshes cannot retain closed gigs.
    gigs = [];
    onChange();
    try {
      const rows = await source.fetchGigs(current.signal);
      if (!enabled || request !== current) return;
      gigs = rows;
      fetchedAt = Date.now();
    } catch {
      if (request === current) {
        gigs = [];
        fetchedAt = Date.now();
      }
    } finally {
      if (request === current) {
        request = null;
        if (enabled) timer = setTimeout(() => void refresh(), ttl);
        onChange();
      }
    }
  };
  const render = (visible: boolean) => {
    host.classList.toggle("hidden", !enabled || !visible);
    if (!enabled || !visible) return;
    if (Date.now() - fetchedAt >= ttl && !request) void refresh();
    renderGigFeed(host, matcher.match(gigs, getSignals()), openUrl);
  };
  toggle.addEventListener("click", () => {
    enabled = !enabled;
    store.set("gigMode", enabled);
    renderToggle();
    clearTimeout(timer);
    if (enabled) void refresh();
    else {
      request?.abort();
      request = null;
      gigs = [];
      host.replaceChildren();
      host.classList.add("hidden");
    }
    onChange();
  });
  renderToggle();
  // Defer the first notification until the caller has assigned its controller.
  if (enabled) queueMicrotask(() => void refresh());
  return { render };
}
