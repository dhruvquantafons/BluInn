"use client";

import { useActionState, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Clock, Eye, EyeOff, LoaderCircle, LockKeyhole, Mail } from "lucide-react";
import { signIn } from "../security-actions";
import type { ActionState } from "../form-utils";
import { Field, inputClass, buttonClass, Banner, Notice } from "../components/ui";
import { keepFormOnSubmit } from "../components/useKeepForm";

const iconInput = `${inputClass} h-11 pl-10 text-[15px]`;
const leadIcon = "w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none transition-colors duration-150 group-focus-within:text-brand-600";

export default function LoginForm() {
  const searchParams = useSearchParams();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(signIn, {});
  const [showPassword, setShowPassword] = useState(false);
  const idle = searchParams.get("reason") === "idle";
  const ended = searchParams.get("reason") === "ended";

  return (
    <form action={formAction} onSubmit={keepFormOnSubmit(formAction)} className="space-y-5">
      <input type="hidden" name="next" value={searchParams.get("next") ?? "/"} />
      {idle && !state.error && (
        <Notice tone="warn">
          <span className="flex items-start gap-2">
            <Clock className="w-4 h-4 shrink-0 mt-0.5" />
            You were signed out after a period of inactivity.
          </span>
        </Notice>
      )}
      {ended && !state.error && (
        <Notice tone="warn">
          <span className="flex items-start gap-2">
            <LockKeyhole className="w-4 h-4 shrink-0 mt-0.5" />
            An administrator ended your session. Sign in again to continue.
          </span>
        </Notice>
      )}
      <Field label="Email">
        <span className="group relative block">
          <Mail className={leadIcon} />
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            autoFocus
            placeholder="you@hotel.com"
            className={iconInput}
          />
        </span>
      </Field>
      <Field label="Password">
        <span className="group relative block">
          <LockKeyhole className={leadIcon} />
          <input
            name="password"
            type={showPassword ? "text" : "password"}
            required
            autoComplete="current-password"
            placeholder="••••••••"
            className={`${iconInput} pr-11`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 w-8 h-8 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors duration-150 cursor-pointer"
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </span>
      </Field>
      <Banner error={state.error} />
      <button
        type="submit"
        disabled={pending}
        className={`${buttonClass} group w-full h-11 gap-2 text-[15px]`}
      >
        {pending ? (
          <>
            <LoaderCircle className="w-4 h-4 animate-spin" />
            <span>Signing in…</span>
          </>
        ) : (
          <>
            <span>Sign in</span>
            <ArrowRight className="w-4 h-4 transition-transform duration-200 ease-out group-hover:translate-x-0.5" />
          </>
        )}
      </button>
    </form>
  );
}
