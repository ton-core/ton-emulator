# TON Emulator
## 🚨 Repository Deprecated and Moved! 🚨

**This repository has been deprecated and is no longer actively maintained.** We have moved our project to a new repository, which you can find here: [ton-org/ton-emulator](https://github.com/ton-org/ton-emulator). The new NPM package is available here: [@ton/emulator](https://www.npmjs.com/package/@ton/emulator)

Please make sure to update your bookmarks and star the new repository to stay up-to-date with the latest developments and updates. This repository will be archived and eventually removed.

**Thank you for your continued support!**
___________

Emulation toolkit for TON Smart Contracts

## Installation

```bash
yarn add ton-emulator ton-core ton-crypto
```

## Usage

```typescript
import { ContractSystem } from 'ton-emulator';

// Contract System is a virtual environment that emulates the TON blockchain
const system = await ContractSystem.create();

// Treasure is a contract that has 1m of TONs and is a handy entry point for your smart contracts
let treasure = await system.treasure('my-treasure');

// Track contract transactions and events
let tracker = system.track(treasure.address);

// Logger to collect VM logs from a contract
let logger = system.log(treasure.address);

// Create a random unknown address that would be treated as unititialized contract
let unknownAddress = testAddress('some-unknown-seed'); // This seed is used to generate deterministic address

// Send an empty message to the unknown address
await treasure.send({
    to: unknownAddress,
    bounce: true,
});

// Run a block
let transactions = await system.run();
console.warn(inspect(transactions, false, 10000));

// Open a contract
let wallet = system.open(WalletContractV4.create({ workchain: 0, publicKey: <some-test-key> }));

// Show contract logs
console.warn(logger.collect());

// Test events and transactions
expect(tracker.collect()).toMatchSnapshot();

```

## License

MIT
