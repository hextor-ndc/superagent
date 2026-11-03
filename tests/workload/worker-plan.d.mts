/** Types for worker-plan.mjs, which stays plain JS so the live ACP agent can import it without a TypeScript loader. */

export declare const LABEL: RegExp
/** Every workload label in a text, in order. */
export declare function labelsOf(text: string | undefined): string[]
/** The first request label (`R07`, without a suffix) in a text. */
export declare function requestLabel(text: string | undefined): string | undefined

export interface WorkerPlan { label?: string; pr?: number; ask: boolean; drop: boolean; ack: boolean; minutes: number }
/** The plan in a request's text. */
export declare function planOf(text: string | undefined): WorkerPlan

export interface Card { trigger_id: string; from?: string; text?: string; preview?: string; [key: string]: unknown }
/** The JSON cards of the messages in a prompt. */
export declare function cardsOf(prompt: string): Card[]

export interface WorkerState {
  started: boolean; asked: boolean; answered: boolean; done: boolean; acked: string[]; handedBack: string[]
  plan?: WorkerPlan; label?: string; triggerId?: string; prUrl?: string
}
export declare function newWorkerState(): WorkerState

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>
export interface TurnResult { label: string; did: string[]; holding: boolean }
/** Runs one turn of a worker; see worker-plan.mjs. */
export declare function runWorkerTurn(input: { prompt: string; callTool: CallTool; state?: WorkerState; finish?: boolean
  openPull?: (number: number, title: string) => Promise<string> }): Promise<TurnResult>
