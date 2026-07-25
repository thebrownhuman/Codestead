export type DisposableLoopbackListener = Readonly<{
  close: () => Promise<void>;
  port: number;
}>;

export type OpenDisposableLoopbackListener = (
  input: Readonly<{
    host: string;
    port: number;
  }>,
) => Promise<DisposableLoopbackListener>;

export function allocateDisposableLoopbackPort(
  input?: Readonly<{
    openListener?: OpenDisposableLoopbackListener;
  }>,
): Promise<number>;
