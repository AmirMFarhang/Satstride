/** Private local owner IPC, implemented by desktop child processes and by the
 * phone's local process transport. No seed-bearing method is exposed over a relay. */
export interface NativeWalletPort {
  call<T>(method: string, params: unknown): Promise<T>
  close(): Promise<void>
}
