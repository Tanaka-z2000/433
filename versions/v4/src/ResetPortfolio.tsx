import { useRef, useState } from "react";

export function ResetPortfolio({
  onReset,
  onExport,
  blocked,
  temporary,
  count,
  canExport,
}: {
  onReset: () => void;
  onExport: () => void;
  blocked: boolean;
  temporary: boolean;
  count: number;
  canExport: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [confirmation, setConfirmation] = useState("");
  return (
    <>
      <button
        className="reset-trigger"
        onClick={() => {
          setConfirmation("");
          dialog.current?.showModal();
          heading.current?.focus({ preventScroll: true });
          if (dialog.current) dialog.current.scrollTop = 0;
        }}
      >
        清空目前輸入
      </button>
      <dialog
        ref={dialog}
        className="reset-dialog"
        aria-labelledby="reset-title"
        aria-describedby="reset-scope"
        onClose={() => setConfirmation("")}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (confirmation !== "清空" || blocked) return;
            dialog.current?.close();
            onReset();
          }}
        >
          <h2 id="reset-title" ref={heading} tabIndex={-1}>
            清空目前輸入，重新填寫？
          </h2>
          <p id="reset-scope">
            將移除目前 {count}{" "}
            個標的，現金、交割款及本次投入／提領歸零，清除目標與情境試算，結束待成交核對。現金下限回到
            10%，容許偏差回到 2 個百分點。
          </p>
          <p>
            歷史快照、既有備份紀錄及其他版本資料保留。若要保留目前填寫內容，請先匯出
            JSON 備份。
          </p>
          <p>
            {temporary
              ? "暫用模式只清空本頁，不改動瀏覽器原有資料。"
              : "確認後會自動保存空白持倉；請查看保存狀態。重新整理不會還原已清空的內容。"}
          </p>
          {blocked && (
            <p role="alert">
              目前保存已停止，暫不允許清空。請取消並先處理保存衝突或資料讀取問題。
            </p>
          )}
          <button type="button" onClick={onExport} disabled={!canExport}>
            先匯出 JSON 備份
          </button>
          {!canExport && (
            <p>目前輸入含無效欄位，請先取消並修正後再匯出備份。</p>
          )}
          <label className="reset-confirm-label">
            輸入「清空」以確認
            <input
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="toolbar">
            <button type="button" onClick={() => dialog.current?.close()}>
              取消
            </button>
            <button
              className="danger"
              type="submit"
              disabled={confirmation !== "清空" || blocked}
            >
              確認清空目前輸入
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
