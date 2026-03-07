e-Lokator — finalny workflow rozliczeń i AI

1. Faktury trafiają do modułu Faktury.
2. Księgowa może użyć Parse albo AI sugestia.
3. Przycisk "Nalicz do szkicu" tworzy/aktualizuje rozliczenia w statusie DRAFT.
4. Lokator nie widzi szkicu w aplikacji.
5. Księgowa przechodzi do modułu Rozliczenia, sprawdza wynik i dopiero klika "Wyślij do lokatora".
6. Dopiero po publikacji rozliczenie staje się widoczne w aplikacji.
7. Email PDF można wysłać osobno przyciskiem "Wyślij email".

AI endpoints:
- POST /api/ai/invoice-analyze
- POST /api/ai/payment-match
- POST /api/ai/meter-anomaly
- POST /api/ai/review-explain

Wymagane env:
- OPENAI_API_KEY
- OPENAI_MODEL_FAST
- OPENAI_MODEL_SMART
- AI_ENABLED
