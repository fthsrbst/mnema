# Mnema Cloud pricing hypothesis

Pricing is deliberately simple and can be changed before launch after measuring
storage, embedding, support, and Merchant-of-Record costs.

| Plan | Monthly price | Intended user | Included |
|---|---:|---|---|
| Community | Free | Self-hosters | Full open-source server; user supplies infrastructure and models |
| Cloud Free | $0 | Evaluation | 2 projects, 1 member, 100 MB, 100k embedding tokens/month |
| Starter | $9 | Individual developer | 10 projects, 1 member, 1 GB, 1M embedding tokens/month |
| Pro | $19 | Power user / small collaboration | 50 projects, 3 members, 5 GB, 5M embedding tokens/month |
| Team | $49 | Small team | 250 projects, 10 members, 20 GB, 20M embedding tokens/month |

The $9 floor matters because Paddle and Lemon Squeezy both publish a 5% + $0.50
base transaction fee. Annual billing should be offered at roughly two months free
to reduce fixed per-transaction cost and churn. Usage above the included allowance
must be blocked or explicitly purchased; it must never create an unbounded bill.

No lifetime plan is offered for hosted service. The Community edition remains the
permanent zero-cost option and prevents cloud pricing from becoming lock-in.
