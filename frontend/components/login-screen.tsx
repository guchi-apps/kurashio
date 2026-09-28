"use client";

import { useEffect, useState } from "react";
import { AppEntryScreen } from "@/components/app-entry-screen";
import { Button } from "@/components/ui/button";
import {
  NATIVE_AUTH_CANCELLED_EVENT,
  isNativeApp,
  startNativeGoogleSignIn,
} from "@/lib/native-app";
import { supabase } from "@/lib/supabase-client";

const SIGN_IN_FAILED = "Googleログインに失敗しました";

function getInitialError(): string {
  if (typeof window === "undefined") return "";
  const authError = new URLSearchParams(window.location.search).get("authError");
  if (authError === "forbidden") return "このGoogleアカウントではログインできません";
  // iOSアプリの認証シートから戻れなかったとき（ios/Kurashio/WebViewModel.swift）
  if (authError === "failed") return SIGN_IN_FAILED;
  return "";
}

/** Googleの公式ロゴ。色は指定どおりに固定するため、テーマで変えない */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-[18px]" aria-hidden>
      <path
        fill="#4285F4"
        d="M45.1 24.5c0-1.6-.1-2.8-.4-4.1H24v7.5h11.9c-.2 2-1.5 5-4.4 7l-.1.3 6.4 4.9.4.1c4.1-3.8 6.9-9.3 6.9-15.7z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.9 0 10.8-1.9 14.4-5.3l-6.9-5.3c-1.8 1.3-4.3 2.2-7.5 2.2-5.8 0-10.7-3.8-12.4-9l-.3.1-6.6 5.1-.1.3C8.2 41.1 15.5 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.6 28.6c-.5-1.4-.7-2.9-.7-4.6s.3-3.2.7-4.6l-.1-.3-6.7-5.2-.2.1C3 17.1 2 20.4 2 24s1 6.9 2.6 10z"
      />
      <path
        fill="#EA4335"
        d="M24 10.4c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.8 4.1 29.9 2 24 2 15.5 2 8.2 6.9 4.6 14l7 5.4c1.7-5.2 6.6-9 12.4-9z"
      />
    </svg>
  );
}

export function LoginScreen() {
  const [error, setError] = useState(getInitialError);
  const [signingIn, setSigningIn] = useState(false);

  // iOSアプリで認証シートを閉じられたら、ボタンを押せる状態へ戻す
  useEffect(() => {
    const handleCancelled = () => setSigningIn(false);
    window.addEventListener(NATIVE_AUTH_CANCELLED_EVENT, handleCancelled);
    return () => window.removeEventListener(NATIVE_AUTH_CANCELLED_EVENT, handleCancelled);
  }, []);

  const handleClick = async () => {
    setError("");
    setSigningIn(true);

    // iOSアプリの中では、Googleが埋め込みブラウザでのログインを拒むため、
    // 認証シート（アプリ側）へ認可URLを渡して往復する（#526）
    if (isNativeApp()) {
      if (!(await startNativeGoogleSignIn())) {
        setError(SIGN_IN_FAILED);
        setSigningIn(false);
      }
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (signInError) {
      setError(SIGN_IN_FAILED);
      setSigningIn(false);
    }
  };

  return (
    <AppEntryScreen>
      <Button
        variant="outline"
        size="lg"
        className="h-12 rounded-full px-6 text-[15px]"
        onClick={handleClick}
        disabled={signingIn}
      >
        <GoogleMark />
        {signingIn ? "Googleへ移動しています" : "Googleでログイン"}
      </Button>
      {error ? (
        <p className="max-w-[280px] rounded-xl bg-destructive/10 px-3.5 py-2 text-[13px] leading-relaxed text-destructive">
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          許可されたアカウントのみログインできます
        </p>
      )}
    </AppEntryScreen>
  );
}
