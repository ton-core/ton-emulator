import { AsyncLock } from "teslabot";
import { Account, Address, beginCell, Cell, ContractState, loadShardAccount, loadTransaction, Message, parseTuple, storeMessage, storeShardAccount, TupleItem, TupleReader } from "@ton/core";
import { createAccount } from "../utils/createAccount";
import { createEmptyAccount } from "../utils/createEmptyAccount";
import { getMethodId } from "../utils/getMethodId";
import { ContractSystem } from "./ContractSystem";

function bigIntToBuffer(v: bigint, bytes: number) {
    return beginCell().storeUint(v, bytes * 8).endCell().beginParse().loadBuffer(bytes);
}

export type GetMethodResult = {
    success: true
    gasUsed: bigint,
    stack: TupleReader,
    exitCode: number,
    logs: string,
} | {
    success: false,
    error: string
}

export class ContractExecutor {

    static createEmpty(address: Address, system: ContractSystem) {
        return new ContractExecutor(createEmptyAccount(address), system);
    }

    static async create(args: { code: Cell, data: Cell, address?: Address, balance?: bigint }, system: ContractSystem) {
        return new ContractExecutor(createAccount(args), system);
    }

    readonly system: ContractSystem;
    readonly address: Address;
    #state: Account;
    #balance: bigint;
    #last: { lt: bigint, hash: bigint } = { lt: 0n, hash: 0n };
    #lock = new AsyncLock();
    #index = 0;

    constructor(state: Account, system: ContractSystem) {
        this.system = system;
        this.address = state.addr;
        this.#state = state;
        this.#balance = this.#state.storage.balance.coins;
    }

    get state(): ContractState {
        let balance = this.#balance;
        let last: {
            lt: bigint;
            hash: Buffer;
        } | null = null;
        if (this.#last) {
            last = {
                lt: this.#last.lt,
                hash: bigIntToBuffer(this.#last.hash, 32),
            }
        }
        if (this.#state.storage.state.type === 'active') {
            return {
                balance,
                last,
                state: {
                    type: 'active',
                    code: this.#state.storage.state.state.code ? this.#state.storage.state.state.code.toBoc() : null,
                    data: this.#state.storage.state.state.data ? this.#state.storage.state.state.data.toBoc() : null,
                }
            }
        } else if (this.#state.storage.state.type === 'uninit') {
            return {
                balance,
                last,
                state: {
                    type: 'uninit',
                }
            }
        } else if (this.#state.storage.state.type === 'frozen') {
            return {
                balance,
                last,
                state: {
                    type: 'frozen',
                    stateHash: bigIntToBuffer(this.#state.storage.state.stateHash, 32),
                }
            }
        } else {
            throw new Error('Unknown contract state');
        }
    }

    get balance() {
        return this.#balance;
    }

    set balance(v: bigint) {
        this.#balance = v;
        this.#state = {
            ...this.#state,
            storage: {
                ...this.#state.storage,
                balance: { ...this.#state.storage.balance, coins: v }
            }
        }
    }

    override = (code: Cell, data: Cell, balance: bigint) => {
        this.#balance = balance;
        this.#state = createAccount({ code, data, address: this.address, balance });
        this.#last = { lt: 0n, hash: 0n };
    }

    get = async (method: string | number, stack?: TupleItem[]): Promise<GetMethodResult> => {
        return await this.#lock.inLock(async () => {

            // Check contract state
            if (this.#state.storage.state.type !== 'active') {
                throw new Error('Contract is not active');
            }
            if (!this.#state.storage.state.state.code) {
                throw new Error('Contract has no code');
            }
            if (!this.#state.storage.state.state.data) {
                throw new Error('Contract has no data');
            }

            // Resolve method id
            let methodId: number;
            if (typeof method === 'string') {
                methodId = getMethodId(method);
            } else {
                methodId = method;
            }

            let result = await this.system.bindings.runGetMethod({
                verbosity: 3,
                address: this.address,
                code: this.#state.storage.state.state.code,
                data: this.#state.storage.state.state.data,
                balance: this.#balance,
                unixtime: this.system.now,
                randomSeed: Buffer.alloc(32),
                gasLimit: 1000000000n,
                methodId: methodId,
                args: stack || [],
                config: this.system.config
            });

            if ((result as any).fail) {
                return {
                    success: false,
                    error: (result as any).message
                };
            }

            // Check result
            if (!result.output.success) {
                return {
                    success: false,
                    error: result.output.error
                };
            }

            // Parse result
            let resultStack = parseTuple(Cell.fromBoc(Buffer.from(result.output.stack, 'base64'))[0]);
            return {
                success: true,
                gasUsed: BigInt(result.output.gas_used),
                stack: new TupleReader(resultStack),
                exitCode: result.output.vm_exit_code,
                logs: result.logs
            };
        });
    }

    async receive(msg: Message) {
        return await this.#lock.inLock(async () => {
            if (msg.info.type !== 'internal' && msg.info.type !== 'external-in') {
                throw new Error(`Unsupported message type: ${msg.info.type}`);
            }

            // Execute transaction
            let res = await this.system.bindings.transaction({
                config: this.system.config,
                libs: null,
                verbosity: 3,
                shardAccount: beginCell().store(storeShardAccount({ account: this.#state, lastTransactionHash: this.#last.hash, lastTransactionLt: this.#last.lt })).endCell(),
                message: beginCell().store(storeMessage(msg)).endCell(),
                now: this.system.now,
                lt: this.system.lt,
                randomSeed: Buffer.alloc(32),
            });

            if ((res as any).fail) {
                throw new Error((res as any).message);
            }

            // Apply changes
            if (res.output.success) {
                let src = Cell.fromBoc(Buffer.from(res.output.shard_account, 'base64'))[0];
                let shard = loadShardAccount(src.beginParse());
                if (shard.account) {
                    this.#state = shard.account!;
                    this.#balance = shard.account!.storage.balance.coins;
                    this.#last = { lt: shard.lastTransactionLt, hash: shard.lastTransactionHash };
                }

                // Load transaction
                let t = loadTransaction(Cell.fromBoc(Buffer.from(res.output.transaction, 'base64'))[0].beginParse());
                return {
                    seq: this.#index++,
                    tx: t,
                    logs: res.logs
                }
            } else {
                console.warn(res.logs);
                throw Error(res.output.error);
            }
        });
    }
}