# MRPscan backend

API reference: [REST_APIS.md](REST_APIS.md). Services: [SERVICES.md](SERVICES.md).

## Pricing

The MRP's arithmetic (weight, gold, wastage, labour, stones, subtotal, the
half-up rupee) is `src/services/pricingMath.js`, run in Node by
`computeMrp`. `tests/pricingGolden.test.js` pins its figures on seeded
realistic prices and on the edge cases.
