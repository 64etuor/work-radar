import React from "react";
import ReactDOM from "react-dom/client";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

import App from "@/App";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/query";
import { PERSIST_BUSTER, PERSIST_MAX_AGE_MS, shouldPersistQuery } from "@/lib/query/persist";
import "@/styles.css";

// P6: ambient 표시 데이터만 localStorage에 persist — 부팅 시 복원으로 첫 페인트 가속.
// 결정 큐(매트릭스/시그널/triage/제안)는 shouldPersistQuery allowlist에서 제외 → 항상 fresh(INVARIANT).
const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: "work-radar-rq-cache",
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        // buster=앱 버전: 스키마/버전 변경 시 기존 디스크 캐시 자동 무효화.
        buster: PERSIST_BUSTER,
        maxAge: PERSIST_MAX_AGE_MS,
        // ambient 표시 키만 dehydrate(결정 큐 제외 — INVARIANT).
        dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
      }}
    >
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </PersistQueryClientProvider>
  </React.StrictMode>,
);
