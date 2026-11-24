"use client";

import { useSyncExternalStore } from "react";

function subscribe(): () => void {
  return () => undefined;
}

function isApple(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

function serverIsApple(): boolean {
  return true;
}

export function useModifierLabel(): string {
  return useSyncExternalStore(subscribe, isApple, serverIsApple) ? "⌘" : "Ctrl";
}
