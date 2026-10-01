"use client";

import { useRef, useState } from "react";
import "../login.css";
import { BrandWordmark } from "../components/BrandMark";
import LoginBackdrop, { type LoginBackdropHandle } from "./LoginBackdrop";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const [tick, setTick] = useState(false);
  const [entering, setEntering] = useState(false);
  const backdrop = useRef<LoginBackdropHandle>(null);
  const tickTimer = useRef<number>(0);

  const type = (value: string) => {
    if (value.length > password.length) {
      backdrop.current?.light();
      setTick(true);
      window.clearTimeout(tickTimer.current);
      tickTimer.current = window.setTimeout(() => setTick(false), 160);
    }
    setPassword(value);
    if (error) setError("");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (response.ok) {
        const next = new URLSearchParams(window.location.search).get("next");
        const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
        setEntering(true);
        backdrop.current?.burst();
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.setTimeout(() => { window.location.href = target; }, reduce ? 200 : 1400);
        return;
      }
      setError("That password is not right.");
      setBusy(false);
      setShake(true);
      window.setTimeout(() => setShake(false), 500);
    } catch {
      setError("Could not reach the server. Try again.");
      setBusy(false);
    }
  };

  return (
    <div className={`login-shell${entering ? " entering" : ""}`}>
      <LoginBackdrop ref={backdrop} />
      <form className={`login-card${shake ? " shake" : ""}${tick ? " tick" : ""}`} onSubmit={submit}>
        <div className="login-brand"><BrandWordmark height={34} /></div>
        <input
          type="password"
          className="login-input"
          value={password}
          onChange={(e) => type(e.target.value)}
          placeholder="Password"
          aria-label="Password"
          autoComplete="current-password"
          autoFocus
        />
        <button className="login-button" type="submit" disabled={busy || !password}>
          {entering ? "Welcome back" : busy ? "Checking…" : "Enter"}
        </button>
        {error && <div className="login-error" role="alert">{error}</div>}
      </form>
    </div>
  );
}
