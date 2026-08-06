import React from "react";

export default function AsyncState({ status, onRetry, children }) {
  if (status === "loading") {
    return (
      <div className="async-state" role="status" aria-label="正在加载">
        <span className="loading-mark" aria-hidden="true" />
        <p>正在加载页面内容…</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="async-state async-state-error" role="alert">
        <strong>暂时无法加载页面数据</strong>
        <p>请检查网络连接后重试，网站导航仍可继续使用。</p>
        <button type="button" onClick={onRetry}>重新加载</button>
      </div>
    );
  }

  if (status === "empty") {
    return <div className="async-state"><p>暂无可显示内容</p></div>;
  }

  return children;
}
