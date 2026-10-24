// Client-side admin commands: same-origin fetch to /api/admin/* with the session's CSRF token, a
// stable Idempotency-Key per submitted command, and a revalidation of the page's loaders on success.
import { useCallback, useRef, useState } from "react";
import { useRevalidator, useRouteLoaderData } from "react-router";
import type { AdminCapability } from "@aihot/contracts/site";
import { toast } from "./toast";

export interface AdminMe {
  name: string;
  csrf: string;
  dev: boolean;
  /** Server-decided (T01 AdminMeView); absent on pre-rollout responses — treated as no capability. */
  capabilities?: AdminCapability[];
}

/** Client mirror of the server guard: a session without capability data is never assumed operator. */
export function meCan(me: AdminMe, cap: AdminCapability): boolean {
  return me.capabilities?.includes(cap) ?? false;
}

export class AdminError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function useAdminMe(): AdminMe {
  return (useRouteLoaderData("admin-layout") as { me: AdminMe } | undefined)?.me ?? { name: "", csrf: "", dev: false };
}

function newKey() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useAdminAction() {
  const me = useAdminMe();
  const revalidator = useRevalidator();
  const [pending, setPending] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());

  const run = useCallback(
    async <T = unknown>(
      method: "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
      opts: { success?: string; label?: string; revalidate?: boolean; cap?: AdminCapability } = {},
    ): Promise<T | null> => {
      const label = opts.label ?? `${method} ${path}`;
      // Client-side refusal only: the server stays the authority; a missing list also refuses.
      const needed = opts.cap ?? "admin:operate";
      if (me.capabilities && !me.capabilities.includes(needed)) {
        toast("当前账号没有这个操作的权限", "error");
        return null;
      }
      // The same command retried after a failure keeps its key, so paid work is not repeated.
      const key = keys.current.get(label) ?? newKey();
      keys.current.set(label, key);
      setPending(label);
      try {
        const res = await fetch(path, {
          method,
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-csrf-token": me.csrf, "idempotency-key": key },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.status === 401) {
          window.location.href = `/api/auth/login?return=${encodeURIComponent(window.location.pathname)}`;
          return null;
        }
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        if (!res.ok) throw new AdminError(res.status, json?.detail ?? `请求失败（${res.status}）`);
        keys.current.delete(label);
        if (opts.success) toast(opts.success, "ok");
        if (opts.revalidate !== false) revalidator.revalidate();
        // null means failure to callers; an empty success (204) is an empty object.
        return (json ?? {}) as T;
      } catch (error) {
        const message = error instanceof AdminError ? error.message : "网络错误，请稍后再试";
        toast(error instanceof AdminError && error.status === 409 ? `${message}` : message, "error");
        return null;
      } finally {
        setPending(null);
      }
    },
    [me.csrf, revalidator],
  );

  return { run, pending, busy: pending !== null || revalidator.state === "loading" };
}
