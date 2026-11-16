# LinkedIn post draft

(Independent project. Do not tag it as a Catena Labs project or imply endorsement.)

---

If an AI agent can pay for things, any web page it reads can try to make it pay.

I wanted to know how much a deterministic policy layer helps, so I built ACK Guard on Catena Labs' open-source Agent Commerce Kit (ACK). Their own payments demo includes a small "policy before signing" example and notes that a per-transaction cap is easily defeated by splitting. ACK Guard builds that next step: cumulative budgets, plus checks that rely only on what ACK makes verifiable:

- the merchant's signature
- that the payment request came back from a service the agent actually called
- the registered payout account and price
- the owner's declared needs

The model's own explanation is logged but never trusted.

I ran 35 payment attacks (fake invoices in emails, swapped payout accounts, inflated amounts, re-billing, lookalike merchants, split payments, hidden instructions) plus 10 normal tasks. Each ran 5 times on the same model, qwen3:8b running locally, with and without the guard, judged on a sandbox ledger:

- Without the guard: 46.9% (82 of 175) of attack runs reached the attacker's goal ($65.20 to attacker accounts).
- With the guard: 0 of 175, and $0.00 to attackers. The first version let 2 through: a re-purchase of the same item under a slightly different URL. I changed the duplicate rule to count what is bought instead of the URL, re-ran the affected attacks, and kept the old result in the report. Zero is a sample, not a guarantee.
- The cost: normal tasks completed 40 of 50 with the guard (50 of 50 without). The other 10 waited for human approval by design: they cost more than $1, and the benchmark's approver says no. After a block, the small model also often gave up on the legitimate part of the task.

I also tested delegation: an agent hands work to a sub-agent under a chain of ACK-ID credentials, each link carrying a budget and the capabilities it may buy. In 5 sub-agent escalation attacks, 5 runs each, the sub-agent overspent its delegation in 9 of 25 runs without the guard and 0 of 25 with it; normal hand-offs completed 10 of 10 either way.

Every decision names the rule that fired and goes into a hash-chained, signed log. You can replay any payment or blocked attempt, export it as a signed dispute evidence pack that anyone can verify, and see that editing, deleting or reordering any entry is detected. Policy changes are replayed against past payments before the owner signs them.

What it does not show: results from frontier models (this was a small local model, which ignored some attack types entirely; a frontier-model run is planned), real money (it is a sandbox), or protection against an attacker steering which item the agent buys.

Live demo, in your browser: https://dudailia.github.io/ack-guard/
Code, results and a walkthrough: https://github.com/dudailia/ack-guard

Built with Claude Code. Independent project, not affiliated with Catena Labs.

#AIagents #payments #security
