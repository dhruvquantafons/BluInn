"use client";

import { useState } from "react";

const LENGTH = 6;

/**
 * The 6-digit code field on the verification step.
 *
 * One real input (name="code") lies transparently over six drawn slots, so
 * the browser's one-time-code autofill, paste, the keyboard and screen
 * readers all work on an ordinary text field; the slots only mirror it.
 * Anything that is not a digit is dropped as it is typed. When the sixth
 * digit arrives the form submits itself.
 */
export default function CodeInput() {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);

  return (
    <div className="relative">
      <input
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={LENGTH}
        autoFocus
        required
        aria-label="6-digit code"
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "").slice(0, LENGTH);
          setValue(digits);
          if (digits.length === LENGTH && value.length < LENGTH) e.target.form?.requestSubmit();
        }}
        className="absolute inset-0 z-10 w-full h-full opacity-0 cursor-text caret-transparent"
      />
      <div aria-hidden="true" className="grid grid-cols-6 gap-2 sm:gap-2.5">
        {Array.from({ length: LENGTH }, (_, i) => {
          const digit = value[i];
          const active = focused && (i === value.length || (i === LENGTH - 1 && value.length === LENGTH));
          return (
            <span
              key={i}
              className={`relative h-14 rounded-xl border bg-white flex items-center justify-center text-2xl font-semibold tabular-nums text-slate-900 transition-[border-color,box-shadow,background-color] duration-150 ${
                active
                  ? "border-brand-500 ring-3 ring-brand-100"
                  : digit
                    ? "border-slate-300 bg-slate-50/60"
                    : "border-slate-200"
              }`}
            >
              {digit ?? ""}
              {active && !digit && <span className="w-px h-6 bg-brand-600 animate-caret" />}
            </span>
          );
        })}
      </div>
    </div>
  );
}
