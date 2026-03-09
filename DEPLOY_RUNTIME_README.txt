e-Lokator – deploy runtime

Ten ZIP zawiera DWA runtime'y, które trzeba wdrożyć osobno:
1) Firebase Functions -> folder functions/
2) Webpanel Next.js -> folder webpanel/

Jeżeli wdrożysz tylko pliki webpanelu, approveInvoice dalej będzie działać na starej wersji Functions.
Jeżeli wdrożysz tylko Functions, UI dalej może pokazywać stary build Next.

Minimalne wdrożenie po tej paczce:
- functions/: npm install, firebase use <project>, firebase deploy --only functions
- webpanel/: npm install, npm run build, wdroż nowy build na hostingu Next.js / Node

Po wdrożeniu usuń stare szkice/rozliczenia wygenerowane przez starą logikę i wygeneruj je ponownie.
Stare refy typu EL-2 2026-03 nie zmienią się same.

Szybka weryfikacja po deployu:
- nowe paymentRef muszą mieć format EL-XXX-XXX-XXX-YYYY-MM
- approveInvoice dla BUILDING / COMMON / COMMUNITY / STAIRCASE nie może zwracać "Brak lokali do naliczenia"
- nowe/odtworzone settlements muszą mieć pola paymentRef, paymentTitle i transferTitle w nowym formacie
