"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  where,
  writeBatch,
} from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { buildFlatKey, buildFlatLabel } from "../../lib/flatMapping";

type Flat = {
  id: string;
  street?: string;
  buildingNo?: string;
  apartmentNo?: string;
  flatLabel?: string;
  flatNumber?: string;
  name?: string;
  firstName?: string;
  surname?: string;
  lastName?: string;
  residentName?: string;
  displayName?: string;
  email?: string;
  phone?: string;
  areaM2?: number;
  residentUid?: string | null;
  userId?: string | null;
  payerId?: string | null;
  flatKey?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
};

type FormState = {
  id: string | null;
  street: string;
  buildingNo: string;
  apartmentNo: string;
  name: string;
  surname: string;
  email: string;
  phone: string;
};

const emptyForm: FormState = {
  id: null,
  street: "",
  buildingNo: "",
  apartmentNo: "",
  name: "",
  surname: "",
  email: "",
  phone: "",
};

function getResidentName(flat: Flat) {
  const direct = String(flat.residentName || "").trim();
  if (direct) return direct;
  const display = String(flat.displayName || "").trim();
  if (display) return display;
  const first = String(flat.name || flat.firstName || "").trim();
  const last = String(flat.surname || flat.lastName || "").trim();
  return [first, last].filter(Boolean).join(" ").trim();
}

function getApartmentNo(flat: Flat) {
  return String(flat.apartmentNo || flat.flatNumber || "").trim();
}

function getFlatLabel(flat: Flat) {
  const explicit = String(flat.flatLabel || "").trim();
  if (explicit) return explicit;
  return buildFlatLabel(flat.street, flat.buildingNo, getApartmentNo(flat));
}

export default function FlatsPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const role = String(profile?.role || "");
  const canEdit = useMemo(() => ["MASTER", "ACCOUNTANT"].includes(role), [role]);

  const [items, setItems] = useState<Flat[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!communityId) return;

    let flatsCache: Flat[] = [];
    let usersByFlatId = new Map<string, any>();

    const sortList = (list: Flat[]) =>
      [...list].sort((a: any, b: any) => {
        const streetCmp = String(a.street || "").localeCompare(String(b.street || ""), "pl");
        if (streetCmp !== 0) return streetCmp;
        const buildingCmp = String(a.buildingNo || "").localeCompare(String(b.buildingNo || ""), "pl", { numeric: true });
        if (buildingCmp !== 0) return buildingCmp;
        return getApartmentNo(a).localeCompare(getApartmentNo(b), "pl", { numeric: true });
      });

    const mergeAndSet = () => {
      const merged = flatsCache.map((flat) => {
        const linkedUser = usersByFlatId.get(flat.id);
        if (!linkedUser) return flat;
        return {
          ...flat,
          residentUid: flat.residentUid || linkedUser.uid || linkedUser.id || null,
          userId: flat.userId || linkedUser.uid || linkedUser.id || null,
          displayName: flat.displayName || linkedUser.displayName || "",
          name: flat.name || flat.firstName || linkedUser.firstName || "",
          surname: flat.surname || flat.lastName || linkedUser.lastName || "",
          email: flat.email || linkedUser.email || "",
          phone: flat.phone || linkedUser.phone || "",
          residentName:
            flat.residentName ||
            [linkedUser.firstName || "", linkedUser.lastName || ""].filter(Boolean).join(" ") ||
            linkedUser.displayName ||
            "",
        } as Flat;
      });
      setItems(sortList(merged));
    };

    const unsubFlats = onSnapshot(query(collection(db, "communities", communityId, "flats")), (snap) => {
      flatsCache = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      mergeAndSet();
    });

    const unsubUsers = onSnapshot(query(collection(db, "users"), where("communityId", "==", communityId)), (snap) => {
      usersByFlatId = new Map(
        snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) }))
          .filter((u: any) => String(u.flatId || "").trim())
          .map((u: any) => [String(u.flatId), u]),
      );
      mergeAndSet();
    });

    return () => {
      unsubFlats();
      unsubUsers();
    };
  }, [communityId]);

  const stats = useMemo(() => {
    const withResidents = items.filter((x) => !!getResidentName(x) || !!x.residentUid || !!x.userId).length;
    const withEmail = items.filter((x) => !!String(x.email || "").trim()).length;
    return { total: items.length, withResidents, withEmail };
  }, [items]);

  const setField = (field: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const startEdit = (flat: Flat) => {
    const resident = getResidentName(flat).split(" ");
    setForm({
      id: flat.id,
      street: String(flat.street || ""),
      buildingNo: String(flat.buildingNo || ""),
      apartmentNo: getApartmentNo(flat),
      name: String(flat.name || flat.firstName || resident[0] || ""),
      surname: String(flat.surname || flat.lastName || resident.slice(1).join(" ") || ""),
      email: String(flat.email || ""),
      phone: String(flat.phone || ""),
    });
    setMsg(`Edytujesz lokal: ${getFlatLabel(flat)}`);
  };

  const resetForm = () => {
    setForm(emptyForm);
    setMsg(null);
  };

  const saveFlat = async () => {
    if (!communityId || !form.street.trim() || !form.buildingNo.trim() || !form.apartmentNo.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const flatKey = buildFlatKey(communityId, form.street, form.buildingNo, form.apartmentNo);
      const allSnap = await getDocs(collection(db, "communities", communityId, "flats"));
      const existing = allSnap.docs.find((d) => {
        if (form.id && d.id === form.id) return true;
        const x: any = d.data();
        const key = String(
          x.flatKey ||
            buildFlatKey(communityId, String(x.street || ""), String(x.buildingNo || ""), String(x.apartmentNo || x.flatNumber || "")),
        );
        return key === flatKey;
      });
      const ref = existing ? doc(db, "communities", communityId, "flats", existing.id) : doc(collection(db, "communities", communityId, "flats"));
      const now = Date.now();
      const flatLabel = buildFlatLabel(form.street, form.buildingNo, form.apartmentNo);
      const batch = writeBatch(db);
      batch.set(
        ref,
        {
          street: form.street.trim(),
          buildingNo: form.buildingNo.trim(),
          apartmentNo: form.apartmentNo.trim(),
          flatNumber: form.apartmentNo.trim(),
          flatLabel,
          flatKey,
          name: form.name.trim(),
          surname: form.surname.trim(),
          residentName: [form.name.trim(), form.surname.trim()].filter(Boolean).join(" "),
          email: form.email.trim(),
          phone: form.phone.trim(),
          updatedAtMs: now,
          createdAtMs: existing?.data()?.createdAtMs || now,
        },
        { merge: true },
      );
      const payerRef = doc(db, "communities", communityId, "payers", ref.id);
      batch.set(
        payerRef,
        {
          flatId: ref.id,
          street: form.street.trim(),
          buildingNo: form.buildingNo.trim(),
          apartmentNo: form.apartmentNo.trim(),
          flatNumber: form.apartmentNo.trim(),
          flatLabel,
          flatKey,
          name: form.name.trim(),
          surname: form.surname.trim(),
          email: form.email.trim(),
          phone: form.phone.trim(),
          mailOnly: !existing?.data()?.residentUid && !!form.email.trim(),
          updatedAtMs: now,
          createdAtMs: existing?.data()?.createdAtMs || now,
        },
        { merge: true },
      );
      resetForm();
      setMsg(existing ? "Zaktualizowano istniejący lokal." : "Dodano nowy lokal.");
    } finally {
      setBusy(false);
    }
  };

  const removeFlat = async (flat: Flat) => {
    if (!communityId) return;
    const ok = window.confirm(`Usunąć lokal ${getFlatLabel(flat)}?`);
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      await Promise.all([
        deleteDoc(doc(db, "communities", communityId, "flats", flat.id)),
        deleteDoc(doc(db, "communities", communityId, "payers", flat.id)).catch(() => undefined),
      ]);
      if (form.id === flat.id) resetForm();
      setMsg(`Usunięto lokal: ${getFlatLabel(flat)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Lokale</h2>

        <div style={{ display: "grid", gap: 12, maxWidth: 980 }}>
          <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
              <div><b>Łącznie lokali:</b> {stats.total}</div>
              <div><b>Z przypisanym mieszkańcem:</b> {stats.withResidents}</div>
              <div><b>Z adresem email:</b> {stats.withEmail}</div>
            </div>
          </div>

          {canEdit && (
            <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
              <h3>{form.id ? "Edytuj lokal" : "Dodaj lub zaktualizuj lokal"}</h3>
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr 1fr" }}>
                <input placeholder="Ulica" value={form.street} onChange={(e) => setField("street", e.target.value)} />
                <input placeholder="Nr budynku" value={form.buildingNo} onChange={(e) => setField("buildingNo", e.target.value)} />
                <input placeholder="Nr lokalu" value={form.apartmentNo} onChange={(e) => setField("apartmentNo", e.target.value)} />
                <input placeholder="Imię" value={form.name} onChange={(e) => setField("name", e.target.value)} />
                <input placeholder="Nazwisko" value={form.surname} onChange={(e) => setField("surname", e.target.value)} />
                <input placeholder="Email" value={form.email} onChange={(e) => setField("email", e.target.value)} />
                <input placeholder="Telefon" value={form.phone} onChange={(e) => setField("phone", e.target.value)} />
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button onClick={saveFlat} disabled={busy}>{form.id ? "Zapisz zmiany" : "Zapisz"}</button>
                {form.id ? <button onClick={resetForm} disabled={busy}>Anuluj edycję</button> : null}
              </div>
              {msg ? <div style={{ marginTop: 10, color: "#9ae6b4" }}>{msg}</div> : null}
            </div>
          )}
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, overflow: "hidden", maxWidth: 1180 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.3fr 0.8fr 1.2fr 1.1fr 0.9fr 1fr", gap: 12, padding: 14, fontWeight: 700, borderBottom: "1px solid rgba(229,229,229,0.25)" }}>
            <div>Lokal</div>
            <div>Numer</div>
            <div>Mieszkaniec</div>
            <div>Email</div>
            <div>Telefon</div>
            <div>Akcje</div>
          </div>
          {items.length === 0 ? (
            <div style={{ padding: 16, opacity: 0.75 }}>Brak lokali do wyświetlenia.</div>
          ) : (
            items.map((flat) => {
              const residentName = getResidentName(flat);
              return (
                <div
                  key={flat.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.3fr 0.8fr 1.2fr 1.1fr 0.9fr 1fr",
                    gap: 12,
                    padding: 14,
                    borderTop: "1px solid rgba(229,229,229,0.12)",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700 }}>{getFlatLabel(flat) || "—"}</div>
                    <div style={{ opacity: 0.7, fontSize: 13 }}>ID: {flat.id}</div>
                  </div>
                  <div>{getApartmentNo(flat) || "—"}</div>
                  <div>
                    <div>{residentName || "Brak danych"}</div>
                    <div style={{ opacity: 0.7, fontSize: 13 }}>
                      {flat.residentUid || flat.userId ? "Użytkownik aplikacji przypisany" : "Brak użytkownika aplikacji"}
                    </div>
                  </div>
                  <div>{flat.email || "—"}</div>
                  <div>{flat.phone || "—"}</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button onClick={() => startEdit(flat)} disabled={!canEdit || busy}>Edytuj</button>
                    <button onClick={() => removeFlat(flat)} disabled={!canEdit || busy}>Usuń</button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </RequireAuth>
  );
}
