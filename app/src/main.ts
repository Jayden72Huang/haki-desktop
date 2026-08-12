import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

interface UsageToday {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  all: number;
  sessions: number;
  scanned_files: number;
}

const $ = (id: string) => document.getElementById(id)!;

const fmt = (n: number): string => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
};

async function refreshUsage() {
  try {
    const u = await invoke<UsageToday>("usage_today");
    const label = `今日 ${fmt(u.all)} tokens`;
    $("pill-tokens").textContent = label;
    $("panel-tokens").textContent = label;
    $("pill-status").textContent = "已同步";
    $("detail-tokens").textContent = `${fmt(u.all)}(输出 ${fmt(u.output)} · 缓存读 ${fmt(u.cache_read)})`;
    $("detail-sessions").textContent = `${u.sessions} 个`;
  } catch (e) {
    $("pill-status").textContent = "读取失败";
    console.error(e);
  }
}

/** 收起/展开切换,同时调整窗口高度贴合内容 */
const PILL_HEIGHT = 64;
const PANEL_HEIGHT = 220;
let expanded = false;

async function setExpanded(next: boolean) {
  expanded = next;
  $("pill").classList.toggle("hidden", expanded);
  $("panel").classList.toggle("hidden", !expanded);
  await getCurrentWindow().setSize(new LogicalSize(660, expanded ? PANEL_HEIGHT : PILL_HEIGHT));
}

window.addEventListener("DOMContentLoaded", () => {
  // 点击胶囊展开、点击面板头部收起;拖拽由 data-tauri-drag-region 处理
  $("pill").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".badge")) return;
    void setExpanded(true);
  });
  $("panel").querySelector(".panel-header")!.addEventListener("click", () => void setExpanded(false));

  void setExpanded(false);
  void refreshUsage();
  setInterval(() => void refreshUsage(), 60_000);
});
