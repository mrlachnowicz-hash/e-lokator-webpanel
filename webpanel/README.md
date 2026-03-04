# e-Lokator – Webpanel (MVP)

## Co to jest
Webpanel (Next.js) jako drugi klient tego samego systemu (Firebase Auth + Firestore + Cloud Functions), z modułami:
- logowanie / role (MASTER / ADMIN / ACCOUNTANT)
- budynki, lokale (CRUD – MVP)
- import lokali z CSV/XLSX (tworzy `flats`, zajmuje seats 1 flat = 1 seat)
- faktury (KSeF) – MVP: pobieranie MOCK, parsowanie XML (heurystyczne), AI sugestie (heurystyka lub OpenAI), zatwierdzenie → generuje `charges` per `flatId`
- generowanie PDF rozliczenia + wysyłka e-mail (SMTP lub MOCK)
- SSO App → Webpanel: `/sso?token=...` wymienia token na Firebase custom token i loguje

## Struktura danych (nowe kolekcje)
Wszystko pod `communities/{communityId}`:
- `buildings/{buildingId}`
- `flats/{flatId}` (payer bez UID wspierany)
- `ksef/config` (MVP – bez tajnych tokenów)
- `ksefInvoices/{invoiceId}`
- `charges/{chargeId}`

Globalne:
- `join_codes/{code}` – join code do rejestracji (ACCOUNTANT)
- `webSessions/{token}` – one-time token do SSO

## Wymagania
- Node.js 18+ (lokalnie)
- Firebase CLI (do emulacji / deploy Functions)

## Uruchomienie lokalnie (DEV)
1) Skopiuj env:
```bash
cp .env.example .env.local
```
2) Uzupełnij w `.env.local`:
- `NEXT_PUBLIC_FIREBASE_*` (Firebase Console → Project settings)
- `FIREBASE_ADMIN_*` (service account JSON)

3) Instalacja:
```bash
npm i
```
4) Start:
```bash
npm run dev
```

Webpanel: http://localhost:3000

## Cloud Functions – wymagane do webpanelu
W katalogu głównym repo: `functions/`

Dodane callable:
- `createJoinCode`, `claimJoinCode`
- `createWebSession`, `consumeWebSession` (fallback)
- `ksefSetConfig`, `ksefFetchInvoices` (MOCK), `ksefParseInvoice`
- `aiSuggestInvoice`
- `approveInvoice`
- `generateSettlementPdf`, `sendSettlementEmail`

### Env Functions
W Firebase Functions (prod) ustaw:
- `OPENAI_API_KEY` (opcjonalnie)
- `OPENAI_MODEL` (opcjonalnie)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (opcjonalnie)

Bez SMTP email jest logowany do `communities/{communityId}/mailLogs`.

## KSeF (MVP)
`ksefFetchInvoices` jest MOCK – produkcyjnie podmień implementację na realne API KSeF.
Parser `ksefParseInvoice` jest heurystyczny (TODO: pełna zgodność z XSD / schematem KSeF).

## SSO z aplikacji Android
Aplikacja powinna:
1) wywołać callable `createWebSession({ target: "/payments" })`
2) otworzyć w WebView URL: `${paymentsUrl}/sso?token=...`

W tym ZIP-ie jest minimalna zmiana po stronie Androida, która dopina token.
