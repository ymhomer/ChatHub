"use client";

import { backendFetch as fetch, appPath, standalone } from "@/lib/site-urls";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { startRegistration } from "@simplewebauthn/browser";


type Methods = {
  user: { displayName: string; email: string };
  email: string | null;
  hasPassword: boolean;
  chatgptLinked: boolean;
  passkeys: { credentialId: string; label: string; createdAt: string }[];
};
type Preview = { token: string; email: string; sourceConversations: number; targetConversations: number; passkeys: number };
type EmailStep = "closed" | "address" | "new" | "existing" | "preview";

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "Unable to finish right now. Please try again later.");
  return data;
}

export default function AccountPage() {
  const [methods, setMethods] = useState<Methods | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [step, setStep] = useState<EmailStep>("closed");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [proofId, setProofId] = useState<string>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mergeConfirmed, setMergeConfirmed] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [chatgptReady, setChatgptReady] = useState(false);
  const [chatgptReturned, setChatgptReturned] = useState(false);

  async function refresh() { setMethods(await api<Methods>("/api/auth/methods")); }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : "Connection failed. Please retry."); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    api<Methods>("/api/auth/methods").then(data => {
      if (!active) return;
      setMethods(data);
      const params = new URLSearchParams(window.location.search);
      setChatgptReturned(params.get("link_chatgpt") === "1");
      if (params.get("merged") === "1") setNotice("Accounts merged. Email, ChatGPT and Passkeys now open the same account.");
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);

  function resetEmail(next: EmailStep = "address") {
    setStep(next); setPassword(""); setConfirmation(""); setProofId(undefined);
    setPreview(null); setMergeConfirmed(false); setError(""); setNotice("");
  }
  function checkEmail(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const result = await api<{ email: string; state: "new" | "existing" | "linked" }>("/api/auth/email-link-state", { email });
      setEmail(result.email); setPassword(""); setConfirmation("");
      if (result.state === "linked") { await refresh(); setStep("closed"); setNotice("This email is already linked to your account."); }
      else setStep(result.state);
    });
  }
  function submitEmail(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      if (step === "new") {
        if (password !== confirmation) throw new Error("The new passwords do not match.");
        const result = await api<{ recoveryCodes: string[] }>("/api/auth/link-email", { email, password });
        setRecoveryCodes(result.recoveryCodes); setPassword(""); setConfirmation("");
        await refresh(); setStep("closed"); setNotice("Email sign-in added. Save your recovery codes below.");
      } else {
        const result = await api<Preview>("/api/auth/merge/prepare", { email, password, proofId });
        setPassword(""); setProofId(undefined); setPreview(result); setMergeConfirmed(false); setStep("preview");
      }
    });
  }
  function confirmMerge(event: FormEvent) {
    event.preventDefault();
    if (!preview || !mergeConfirmed) return;
    void run(async () => {
      await api("/api/auth/merge/confirm", { token: preview.token, confirmed: true });
      window.location.replace(appPath("/account/?merged=1"));
    });
  }
  function startChatGPTLink() {
    void run(async () => { await api("/api/auth/chatgpt-link/start", {}); setChatgptReady(true); setChatgptReturned(false); });
  }
  function finishChatGPTLink() {
    void run(async () => {
      const result = await api<{ linked?: boolean; mergeRequired?: boolean; proofId?: string; email?: string }>("/api/auth/link-chatgpt", {});
      setChatgptReturned(false); setChatgptReady(false); window.history.replaceState({}, "", "/account");
      if (result.mergeRequired && result.proofId && result.email) {
        setEmail(result.email); setProofId(result.proofId); setPassword(""); setStep("existing");
        setNotice("This ChatGPT identity has another ChatHub account. Verify your email password, then review the merge.");
      } else { await refresh(); setNotice("ChatGPT linked. Both sign-in methods now open this account."); }
    });
  }
  function addPasskey() {
    void run(async () => {
      const start = await api<{ options: Parameters<typeof startRegistration>[0]["optionsJSON"]; challengeId: string }>("/api/auth/passkey/register-options", {});
      const response = await startRegistration({ optionsJSON: start.options });
      await api("/api/auth/passkey/register", { challengeId: start.challengeId, response, label: "My Passkey" });
      await refresh(); setNotice("Passkey added to this account.");
    });
  }
  function removePasskey(id: string) {
    void run(async () => {
      const response = await fetch(`/api/auth/passkey/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "Unable to remove Passkey.");
      await refresh(); setNotice("Passkey removed.");
    });
  }
  function logout() {
    void run(async () => { await api("/api/auth/logout", {}); window.location.href = standalone ? appPath("/") : "/signout-with-chatgpt?return_to=%2F"; });
  }

  if (!methods) return <main className="account-page"><p role="status">{error || "Loading account…"}</p><a href={appPath("/")}>Back to ChatHub / Sign in</a></main>;
  const emailLinked = Boolean(methods.email && methods.hasPassword);
  const identityCount = Number(emailLinked) + Number(methods.chatgptLinked) + methods.passkeys.length;

  return <main className="account-page">
    <a className="account-back" href={appPath("/")}>← Back to ChatHub</a>
    <section className="account-card">
      <span className="eyebrow">Account security</span><h1>Sign-in & recovery</h1>
      <p className="account-intro">Add sign-in methods here. If both identities already have ChatHub accounts, verify both and confirm the merge to bring their content together.</p>
      {notice && <div className="auth-notice" role="status">{notice}</div>}
      {error && <p className="send-error" role="alert">{error}</p>}
      {recoveryCodes.length > 0 && <div className="recovery-panel account-recovery">
        <h2>Save recovery codes</h2><p>These codes are shown only once. Each code can be used once.</p>
        <pre>{recoveryCodes.join("\n")}</pre>
        <button className="account-action" disabled={busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(recoveryCodes.join("\n")); setNotice("Recovery codes copied. Keep them somewhere safe."); })}>Copy codes</button>
      </div>}
      <div className="account-method"><div><strong>Email + password</strong><small>{emailLinked ? methods.email : "Email sign-in not set up"}</small></div>
        {emailLinked ? <span className="method-state">Linked</span> : <button className="account-action" disabled={busy} onClick={() => resetEmail()}>Add email sign-in</button>}
      </div>
      {!emailLinked && step === "address" && <form className="link-email-form account-step" onSubmit={checkEmail}>
        <h2>1 · Enter your email</h2><p>Enter the email you want to use. We will check whether it already has an account.</p>
        <label>Email<input name="link-email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <button className="account-action" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
        <button className="auth-link" type="button" disabled={busy} onClick={() => resetEmail("closed")}>Cancel</button>
      </form>}
      {(step === "new" || step === "existing") && <form className="link-email-form account-step" onSubmit={submitEmail}>
        <h2>{step === "new" ? "2 · Create email sign-in" : "2 · Verify existing email account"}</h2>
        <p className="account-selected-email">{email}</p>
        <p>{step === "new" ? "This email is not registered. Set a new password to add email sign-in to your current ChatHub account." : "This email already has a ChatHub account. Enter its existing password to review a merge before any account changes."}</p>
        <label>{step === "new" ? "New ChatHub password" : "Existing ChatHub email password"}<input name={step === "new" ? "new-password" : "existing-password"} type="password" autoComplete={step === "new" ? "new-password" : "current-password"} minLength={step === "new" ? 12 : undefined} maxLength={128} required value={password} onChange={e => setPassword(e.target.value)} /></label>
        {step === "new" && <label>Confirm new password<input name="confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirmation} onChange={e => setConfirmation(e.target.value)} /><small>At least 12 characters. This is separate from your ChatGPT password.</small></label>}
        <button className="account-action" disabled={busy}>{busy ? "Working…" : step === "new" ? "Add email sign-in to this account" : "Verify password & review merge"}</button>
        <button className="auth-link" type="button" disabled={busy} onClick={() => resetEmail()}>Back to email address</button>
        {step === "new" && <small className="account-flow-note">Email verification is not available. Check your address carefully and save your recovery codes.</small>}
        {step === "existing" && <small className="account-flow-note">Forgot your password? Sign out and recover it with a recovery code, then link again.</small>}
      </form>}
      {step === "preview" && preview && <form className="account-step merge-preview" onSubmit={confirmMerge}>
        <h2>3 · Confirm account merge</h2><p>Keep email account: <strong className="account-selected-email">{preview.email}</strong></p>
        <ul><li>ChatGPT account: {preview.sourceConversations} conversations</li><li>Email account: {preview.targetConversations} conversations</li><li>Keep messages, attachments and {preview.passkeys} Passkeys</li><li>Existing email password and recovery codes remain valid</li><li>Other devices will need to sign in again after merging</li></ul>
        <p>After merging, all sign-in methods open one account. This cannot be undone here.</p>
        <label className="merge-confirm"><input type="checkbox" checked={mergeConfirmed} onChange={e => setMergeConfirmed(e.target.checked)} required />I own both accounts and agree to merge their content.</label>
        <button className="account-action" disabled={busy || !mergeConfirmed}>{busy ? "Merging…" : "Confirm merge & link"}</button>
        <button className="auth-link" type="button" disabled={busy} onClick={() => resetEmail("closed")}>Cancel merge</button>
        <small className="account-flow-note">Verification expires in 5 minutes. Canceling does not change either account.</small>
      </form>}
      {!standalone && <div className="account-method"><div><strong>ChatGPT</strong><small>{methods.chatgptLinked ? "Linked; ChatGPT sign-in does not create an email password" : "Not linked"}</small></div>
        {methods.chatgptLinked ? <span className="method-state">Linked</span> : <button className="account-action" disabled={busy} onClick={startChatGPTLink}>Add ChatGPT sign-in</button>}
      </div>}
      {chatgptReady && <div className="account-step"><p>Continue to ChatGPT to verify your identity, then return to confirm linking.</p><a className="account-action" href="/signin-with-chatgpt?return_to=%2Faccount%3Flink_chatgpt%3D1" target="_top">Continue to ChatGPT</a></div>}
      {chatgptReturned && <div className="account-step"><p>You have returned from ChatGPT. Confirm linking the identity you just verified.</p><button className="account-action" disabled={busy} onClick={finishChatGPTLink}>{busy ? "Checking…" : "Link this ChatGPT identity"}</button></div>}
      <div className="account-method"><div><strong>Passkey</strong><small>{methods.passkeys.length ? `${methods.passkeys.length} Passkeys` : "Sign in with device biometrics or a security key"}</small></div><button className="account-action" disabled={busy} onClick={addPasskey}>Add Passkey</button></div>
      {methods.passkeys.map(key => <div className="account-method nested" key={key.credentialId}><div><strong>{key.label}</strong><small>Created {new Date(key.createdAt).toLocaleDateString()}</small></div><button className="remove-action" disabled={busy || identityCount <= 1} onClick={() => removePasskey(key.credentialId)}>Remove</button></div>)}
      <div className="recovery-hint"><strong>Recovery Code</strong><p>Email setup provides one-use recovery codes. Choose Recover on the sign-in page if you forget your password. Resetting your password invalidates all old codes; save the new set.</p></div>
      <div className="account-footer"><span>{methods.user.displayName}</span><button className="remove-action" disabled={busy} onClick={logout}>Sign out</button></div>
    </section>
  </main>;
}
