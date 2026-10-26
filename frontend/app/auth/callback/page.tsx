"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { AppLoadingScreen } from "@/components/app-loading-screen";
import { authHeaders, signOutThisApp } from "@/lib/auth";
import { completeAuthCallback } from "@/lib/auth-callback";
import { supabase } from "@/lib/supabase-client";

export default function AuthCallbackPage() {
  const router = useRouter();
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    (async () => {
      const code = new URLSearchParams(window.location.search).get("code");
      const result = await completeAuthCallback(code, {
        exchangeCode: (value) => supabase.auth.exchangeCodeForSession(value),
        checkMe: async () => fetch("/api/auth/me", { headers: await authHeaders() }),
        discardSession: signOutThisApp,
      });
      if (!result.ok) {
        router.replace(`/?authError=${result.error}`);
        return;
      }

      router.replace("/");
    })();
  }, [router]);

  // 何も描かないと真っ白な画面になる。ホームと同じ読み込み画面でつなぐ（#250）
  return <AppLoadingScreen label="ログインしています" />;
}
