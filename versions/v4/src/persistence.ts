import { useEffect, useRef, useState } from "react";
import { KEY } from "./storage";

// A storage baseline also catches tab conflicts when the storage event arrives late.
export function usePersistence(
  text: string,
  valid: boolean,
  temporary: boolean,
  initialRaw: string | null,
  initiallyBlocked: boolean,
) {
  const baseline = useRef(initialRaw);
  const paused = useRef(initiallyBlocked);
  const latest = useRef({ text, valid });
  latest.current = { text, valid };
  const [blocked, setBlocked] = useState(initiallyBlocked);
  const [status, setStatus] = useState(
    temporary
      ? "暫用模式：不讀取或寫入瀏覽器資料"
      : initiallyBlocked
        ? "無法讀取既有資料，已停止保存"
        : initialRaw
          ? "已載入此瀏覽器的 V4 資料"
          : "尚無 V4 保存資料",
  );
  const [saved, setSaved] = useState(initialRaw);
  const [retry, setRetry] = useState(0);
  const flush = () => {
    const next = latest.current;
    if (
      temporary ||
      paused.current ||
      !next.valid ||
      next.text === baseline.current
    )
      return;
    try {
      if (localStorage.getItem(KEY) !== baseline.current) {
        paused.current = true;
        setBlocked(true);
        setStatus(
          "另一個分頁已變更資料，已停止保存。請先匯出目前內容，再重新載入。",
        );
        return;
      }
      localStorage.setItem(KEY, next.text);
      baseline.current = next.text;
      setSaved(next.text);
      setStatus(`已保存於此瀏覽器 · ${new Date().toLocaleTimeString("zh-TW")}`);
    } catch {
      setStatus("保存失敗，請匯出 JSON 備份或重試");
    }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    if (temporary || blocked) return;
    if (!valid) {
      setStatus("本次輸入未完整，尚未保存；上次有效資料仍保留");
      return;
    }
    if (text === baseline.current) {
      setStatus("已保存於此瀏覽器，內容與上次保存相同");
      return;
    }
    setStatus("修改尚未保存，稍停輸入後自動保存");
    const timer = setTimeout(() => flushRef.current(), 650);
    return () => clearTimeout(timer);
  }, [text, valid, temporary, blocked, retry]);
  useEffect(() => {
    if (temporary) return;
    const visibility = () => {
      if (document.visibilityState === "hidden") flushRef.current();
    };
    const leave = () => flushRef.current();
    const before = (e: BeforeUnloadEvent) => {
      flushRef.current();
      if (latest.current.text !== baseline.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const changed = (e: StorageEvent) => {
      if (
        e.storageArea === localStorage &&
        (e.key === KEY || e.key === null) &&
        e.newValue !== baseline.current
      ) {
        paused.current = true;
        setBlocked(true);
        setStatus(
          "另一個分頁已變更或清除資料，已停止保存。請先匯出目前內容，再重新載入。",
        );
      }
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", leave);
    window.addEventListener("beforeunload", before);
    window.addEventListener("storage", changed);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("beforeunload", before);
      window.removeEventListener("storage", changed);
    };
  }, [temporary]);
  return {
    blocked,
    status,
    saved,
    retry: () => setRetry((n) => n + 1),
    replaceDamaged: () => {
      try {
        baseline.current = localStorage.getItem(KEY);
        paused.current = false;
        setBlocked(false);
        setRetry((n) => n + 1);
      } catch {
        setStatus("瀏覽器仍拒絕存取資料，請改用暫用模式並匯出備份");
      }
    },
  };
}
