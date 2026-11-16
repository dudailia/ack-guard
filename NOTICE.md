# Third-party notices

## Agent Commerce Kit (ACK)

ACK Guard depends on the Agent Commerce Kit packages published by Catena Labs
(`agentcommercekit` and `@agentcommercekit/*`, version 0.11.0) and follows
patterns from the ACK repository (https://github.com/agentcommercekit/ack):

- the server-initiated ACK-Pay flow (HTTP 402, signed PaymentRequest,
  PaymentReceiptCredential) from `demos/payments`
- the agent did:web document with an owner `controller` and the ACK-ID
  ControllerCredential from `demos/e2e` and `demos/identity`
- the "policy before signing" idea from `demos/payments/src/payment-policy.ts`,
  which this project's policy engine extends

ACK Guard is an independent project. It is not affiliated with, sponsored by
or endorsed by Catena Labs.

The ACK license:

MIT License

Copyright (c) 2025 Catena Labs, Inc. and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
