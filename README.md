# e-Lokator – Webpanel

## Zakres w tym ZIP
- auth + role guard (MASTER / ACCOUNTANT)
- panel access przez `panelAccessEnabled`
- import lokali do `communities/{communityId}/flats` + `payers`
- budynki i lokale na istniejących danych Firebase
- faktury / review / settlements / payments
- nowy moduł `Liczniki`
- PDF rozliczenia przez route Next.js
- email rozliczenia przez SendGrid z ENV
- SSO consume rout

## Źródło prawdy danych
System czyta istniejące:
- `communities
- `users`
- `communities/{communityId}/flats`
- pola `communityId`, `flatId`, `street`, `buildingNo`, `apartmentNo`, `flatLabel`

Nie trzeba zakładać wspólnot od nowa.

## Uruchomienie lokalne
```bash
cp .env.example .env.local
npm install
npm run dev
```

## Wymagane ENV
Uzupełnij w `.env.local`:
- `NEXT_PUBLIC_FIREBASE_*`
- `FIREBASE_ADMIN_PROJECT_ID`
- `FIREBASE_ADMIN_CLIENT_EMAIL`
- `FIREBASE_ADMIN_PRIVATE_KEY`
- `SENDGRID_API_KEY`
- `SENDGRID_FROM_EMAIL`
- opcjonalnie `SENDGRID_EU_DATA_RESIDENCY=true`

## SendGrid
Email rozliczenia działa przez route:
- `POST /api/settlements/[settlementId]/send-email`

PDF działa przez:
- `GET /api/settlements/[settlementId]/pdf?communityId=...`

Klucz API wklej do `.env.local` w polu `SENDGRID_API_KEY`.
Email nadawcy ustaw w `SENDGRID_FROM_EMAIL`.

## Liczniki
Nowe kolekcje:
- `communities/{communityId}/meters`
- `communities/{communityId}/meterReadings`

Import odczytów tworzy też wpisy w:
- `communities/{communityId}/charges`


