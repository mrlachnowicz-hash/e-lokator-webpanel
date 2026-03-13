"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { Nav } from "@/components/Nav";
import { RequireAuth } from "@/components/RequireAuth";
import { useAuth } from "@/lib/authContext";
import { db } from "@/lib/firebase";
import { callable } from "@/lib/functions";

const upsertAiSource = callable<any, any>("upsertAiSource");
const deleteAiSource = callable<any, any>("deleteAiSource");
const refreshAiSource = callable<any, any>("refreshCommunityAiSource");
const refreshAllAi = callable<any, any>("refreshCommunityAi");
const setAiNewsState = callable<any, any>("setAiNewsState");

type AiSource = {
  id: string;
  name?: string;
  url?: string;
  category?: string;
  refreshEveryMinutes?: number;
  filterRules?: string;
  enabled?: boolean;
  publishAsAnnouncement?: boolean;
  lastRefreshAtMs?: number;
  lastError?: string;
  deleted?: boolean;
};

type AiNews = {
  id: string;
  title?: string;
  aiSummary?: string;
  sourceName?: string;
  category?: string;
  priority?: string;
  important?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  archived?: boolean;
  publishedAsAnnouncement?: boolean;
  updatedAtMs?: number;
};

const emptyForm = {
  sourceId: "",
  name: "",
  url: "",
  category: "",
  refreshEveryMinutes: "360",
  filterRules: "",
  enabled: true,
  publishAsAnnouncement: false,
};

export default function CommunityAiPage() {
  const { profile } = useAuth();
  const communityId = String(profile?.communityId || "");
  const [sources, setSources] = useState<AiSource[]>([]);
  const [news, setNews] = useState<AiNews[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!communityId) return;
    const unsubSources = onSnapshot(query(collection(db, "communities", communityId, "aiSources"), orderBy("updatedAtMs", "desc")), (snap) => {
      setSources(snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as any) })).filter((item) => item.deleted !== true));
    });
    const unsubNews = onSnapshot(query(collection(db, "communities", communityId, "aiNews"), orderBy("updatedAtMs", "desc")), (snap) => {
      setNews(snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as any) })));
    });
    return () => {
      unsubSources();
      unsubNews();
    };
  }, [communityId]);

  const visibleNews = useMemo(() => news.filter((item) => item.hidden !== true), [news]);

  function startEdit(source: AiSource) {
    setForm({
      sourceId: source.id,
      name: String(source.name || ""),
      url: String(source.url || ""),
      category: String(source.category || ""),
      refreshEveryMinutes: String(source.refreshEveryMinutes || 360),
      filterRules: String(source.filterRules || ""),
      enabled: source.enabled !== false,
      publishAsAnnouncement: source.publishAsAnnouncement === true,
    });
  }

  async function saveSource() {
    if (!communityId || !form.name.trim() || !form.url.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      await upsertAiSource({
        communityId,
        sourceId: form.sourceId || undefined,
        name: form.name.trim(),
        url: form.url.trim(),
        category: form.category.trim(),
        refreshEveryMinutes: Number(form.refreshEveryMinutes || 360),
        filterRules: form.filterRules.trim(),
        enabled: form.enabled,
        publishAsAnnouncement: form.publishAsAnnouncement,
      });
      setForm(emptyForm);
      setMessage("Zapisano źródło Wspólnota AI.");
    } catch (error: any) {
      setMessage(error?.message || "Błąd zapisu źródła AI.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshSourceNow(sourceId: string) {
    setBusy(true);
    setMessage("");
    try {
      await refreshAiSource({ communityId, sourceId });
      setMessage("Uruchomiono ręczny refresh źródła.");
    } catch (error: any) {
      setMessage(error?.message || "Błąd refreshu źródła.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshAll() {
    setBusy(true);
    setMessage("");
    try {
      const res: any = await refreshAllAi({ communityId });
      const count = Array.isArray(res?.data?.results) ? res.data.results.length : 0;
      setMessage(`Odświeżono Wspólnota AI. Źródeł: ${count}.`);
    } catch (error: any) {
      setMessage(error?.message || "Błąd zbiorczego refreshu AI.");
    } finally {
      setBusy(false);
    }
  }

  async function removeSource(sourceId: string) {
    if (!communityId) return;
    setBusy(true);
    setMessage("");
    try {
      await deleteAiSource({ communityId, sourceId });
      setMessage("Źródło AI zostało wyłączone.");
    } catch (error: any) {
      setMessage(error?.message || "Błąd usuwania źródła.");
    } finally {
      setBusy(false);
    }
  }

  async function updateNewsState(newsId: string, patch: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      await setAiNewsState({ communityId, newsId, ...patch });
      setMessage("Zaktualizowano status wiadomości AI.");
    } catch (error: any) {
      setMessage(error?.message || "Błąd aktualizacji wiadomości AI.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <RequireAuth roles={["MASTER", "ADMIN"]} requirePanelAccess={false}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16, maxWidth: 1100 }}>
        <h1 style={{ margin: 0 }}>Wspólnota AI</h1>
        <p style={{ margin: 0, opacity: 0.8 }}>
          Moduł zapisuje źródła WWW wspólnoty, wykonuje backendowy refresh i publikuje skróty AI dla mieszkańców.
        </p>

        <div className="card" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button className="btn" onClick={refreshAll} disabled={busy || !communityId}>Odśwież wszystko</button>
          <div>Źródła: <strong>{sources.length}</strong></div>
          <div>Widoczne newsy: <strong>{visibleNews.length}</strong></div>
          <div>Ważne: <strong>{visibleNews.filter((item) => item.important).length}</strong></div>
        </div>

        <div className="card" style={{ display: "grid", gap: 12 }}>
          <h3 style={{ margin: 0 }}>{form.sourceId ? "Edytuj źródło" : "Dodaj źródło"}</h3>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <input className="input" placeholder="Nazwa źródła" value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
            <input className="input" placeholder="URL strony wspólnoty" value={form.url} onChange={(e) => setForm((prev) => ({ ...prev, url: e.target.value }))} />
            <input className="input" placeholder="Kategoria" value={form.category} onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))} />
            <input className="input" type="number" min={15} step={15} placeholder="Co ile minut odświeżać" value={form.refreshEveryMinutes} onChange={(e) => setForm((prev) => ({ ...prev, refreshEveryMinutes: e.target.value }))} />
          </div>
          <textarea className="input" placeholder="Reguły filtrowania treści" value={form.filterRules} onChange={(e) => setForm((prev) => ({ ...prev, filterRules: e.target.value }))} style={{ minHeight: 100 }} />
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))} />
            Źródło aktywne
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={form.publishAsAnnouncement} onChange={(e) => setForm((prev) => ({ ...prev, publishAsAnnouncement: e.target.checked }))} />
            Publikuj ważne newsy także jako ogłoszenia
          </label>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn" onClick={saveSource} disabled={busy || !communityId}>Zapisz źródło</button>
            {form.sourceId ? <button className="btnGhost" onClick={() => setForm(emptyForm)} disabled={busy}>Anuluj edycję</button> : null}
          </div>
          {message ? <div style={{ color: message.toLowerCase().includes("błąd") ? "#ffb3b3" : "#8ef0c8" }}>{message}</div> : null}
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          {sources.map((source) => (
            <div key={source.id} className="card" style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <strong>{source.name || source.id}</strong>
                  <div style={{ opacity: 0.75 }}>{source.url}</div>
                  <div style={{ opacity: 0.75, fontSize: 13 }}>
                    {source.category || "Brak kategorii"} · co {source.refreshEveryMinutes || 360} min · {source.enabled === false ? "wyłączone" : "aktywne"}
                  </div>
                  {source.lastRefreshAtMs ? <div style={{ opacity: 0.75, fontSize: 13 }}>Ostatni refresh: {new Date(source.lastRefreshAtMs).toLocaleString()}</div> : null}
                  {source.lastError ? <div style={{ color: "#ffb3b3", fontSize: 13 }}>Błąd: {source.lastError}</div> : null}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="btnGhost" onClick={() => startEdit(source)} disabled={busy}>Edytuj</button>
                  <button className="btnGhost" onClick={() => refreshSourceNow(source.id)} disabled={busy}>Refresh teraz</button>
                  <button className="btnGhost" onClick={() => removeSource(source.id)} disabled={busy}>Usuń</button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          {visibleNews.map((item) => (
            <div key={item.id} className="card" style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <strong>{item.title || "Wspólnota AI"}</strong>
                  <div style={{ opacity: 0.75 }}>{item.sourceName || "Źródło wspólnoty"} · {item.category || "ADMINISTRACJA"} · {item.priority || "LOW"}</div>
                  <div style={{ marginTop: 8 }}>{item.aiSummary || "Brak skrótu AI."}</div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="btnGhost" onClick={() => updateNewsState(item.id, { important: !item.important })} disabled={busy}>{item.important ? "Odznacz ważne" : "Oznacz ważne"}</button>
                  <button className="btnGhost" onClick={() => updateNewsState(item.id, { pinned: !item.pinned })} disabled={busy}>{item.pinned ? "Odepnij" : "Przypnij"}</button>
                  <button className="btnGhost" onClick={() => updateNewsState(item.id, { hidden: !item.hidden })} disabled={busy}>{item.hidden ? "Pokaż" : "Ukryj"}</button>
                  <button className="btnGhost" onClick={() => updateNewsState(item.id, { archived: !item.archived })} disabled={busy}>{item.archived ? "Przywróć" : "Archiwizuj"}</button>
                  <button className="btnGhost" onClick={() => updateNewsState(item.id, { publishAsAnnouncement: true })} disabled={busy || item.publishedAsAnnouncement === true}>
                    {item.publishedAsAnnouncement ? "Opublikowano" : "Publikuj jako ogłoszenie"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </RequireAuth>
  );
}
