// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useState } from "react";
import "../login.css";

/**
 * The password screen. The only page reachable without a session — the middleware lets it and the auth
 * endpoints through, and gates everything else. On a correct password the cookie comes back on the response
 * and the reader is sent on to wherever they were headed (the `next` the middleware attached), or home.
 */
export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
        // Only ever an in-site path, never an absolute URL somebody appended to the address.
        window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
        return;
      }
      setError("That password is not right.");
      setBusy(false);
    } catch {
      setError("Could not reach the server. Try again.");
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">reply<span>radar</span></div>
        <p className="login-sub">Enter the password to continue.</p>
        <input
          type="password"
          className="login-input"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          aria-label="Password"
          autoComplete="current-password"
        />
        <button className="login-button" type="submit" disabled={busy || !password}>
          {busy ? "Checking…" : "Enter"}
        </button>
        {error && <div className="login-error">{error}</div>}
      </form>
    </div>
  );
}
