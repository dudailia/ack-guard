# LinkedIn post draft

(Independent project. Do not tag it as a Catena Labs project or imply endorsement. Link the repo once it is public.)

---

If an AI agent can pay for things, any web page it reads can try to make it pay.

I wanted to know how much a deterministic policy layer helps, so I built ACK Guard on Catena Labs' open-source Agent Commerce Kit (ACK). Their own payments demo includes a small "policy before signing" example and notes that a per-transaction cap is easily defeated by splitting. ACK Guard builds that next step: cumulative budgets, plus checks that rely only on what ACK makes verifiable:

- the merchant's signature
- that the payment request came back from a service the agent actually called
- the registered payout account and price
- the owner's declared needs

The model's own explanation is logged but never trusted.

I ran 35 payment attacks (fake invoices in emails, swapped payout accounts, inflated amounts, re-billing, lookalike merchants, split payments, hidden instructions) plus 10 normal tasks. Each ran 5 times against the same local model, with and without the guard, judged on a sandbox ledger:

- Without the guard: 47% (82 of 175) of attack runs moved money the owner did not intend ($65.20 to attacker accounts).
- With the guard: 0 of 175, and $0.00 to attackers. The first version let 2 through: a re-purchase of the same item under a slightly different URL. I changed the duplicate rule to count what is bought instead of the URL, re-ran the affected attacks, and kept the old result in the report. Zero is a sample, not a guarantee.
- The cost: payments above $1 wait for a human, and after a block the small model often gave up on the legitimate part of the task.

Every decision names the rule that fired and goes into a hash-chained, signed log. You can replay any payment or blocked attempt and re-verify its receipt, and editing, deleting or reordering any entry is detected.

What it does not show: results from frontier models (this was a small local model, which ignored some attack types entirely), real money (it is a sandbox), or protection against an attacker steering which item the agent buys.

Code, results and a walkthrough: [link]

Built with Claude Code. Independent project, not affiliated with Catena Labs.

#AIagents #payments #security
