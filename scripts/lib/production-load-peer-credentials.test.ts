import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  collectProductionLoadPeerCredentialsOnChildClose,
  parseProductionLoadPeerCredentials,
  runProductionLoadTestControlAfterPeerAuthorization,
  type ProductionLoadPeerCredentialResolver,
} from "./production-load-test-control-server";

const socket = {} as Socket;

describe("production load test-control peer credentials", () => {
  it("accepts only one canonical Linux SO_PEERCRED result", () => {
    expect(parseProductionLoadPeerCredentials(
      Buffer.from('{"pid":4321,"uid":0,"gid":0}\n', "utf8"),
    )).toEqual({ pid: 4321, uid: 0, gid: 0 });

    for (const value of [
      '{"uid":0,"pid":4321,"gid":0}\n',
      '{"pid":4321,"uid":0,"gid":0,"token":"secret"}\n',
      '{"pid":4321,"uid":"0","gid":0}\n',
      '{"pid":-1,"uid":0,"gid":0}\n',
      '{"pid":4321,"uid":0,"gid":0}',
      '{"pid":4321, "uid":0,"gid":0}\n',
      "not-json\n",
      "x".repeat(257),
    ]) {
      expect(() => parseProductionLoadPeerCredentials(Buffer.from(value, "utf8"))).toThrow(
        "invalid_peer_credentials",
      );
    }
  });

  it("runs downstream work only for a proven root peer", async () => {
    const resolvePeerCredentials: ProductionLoadPeerCredentialResolver = vi.fn(async () => ({
      pid: 4321,
      uid: 0,
      gid: 0,
    }));
    const downstream = vi.fn(async () => "accepted");
    const controller = new AbortController();

    await expect(runProductionLoadTestControlAfterPeerAuthorization({
      socket,
      signal: controller.signal,
      resolvePeerCredentials,
      authorized: downstream,
    })).resolves.toBe("accepted");
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-root peer before any downstream adapter work", async () => {
    const resolvePeerCredentials: ProductionLoadPeerCredentialResolver = vi.fn(async () => ({
      pid: 4321,
      uid: 1000,
      gid: 1000,
    }));
    const downstream = vi.fn(async () => "must-not-run");

    await expect(runProductionLoadTestControlAfterPeerAuthorization({
      socket,
      signal: new AbortController().signal,
      resolvePeerCredentials,
      authorized: downstream,
    })).rejects.toThrow("peer_unauthorized");
    expect(downstream).not.toHaveBeenCalled();
  });

  it("fails closed when SO_PEERCRED acquisition fails or is malformed", async () => {
    const resolvers: ProductionLoadPeerCredentialResolver[] = [
      vi.fn(async () => { throw new Error("helper path and token must not escape"); }),
      vi.fn(async () => ({ pid: 0, uid: 0, gid: 0 })),
      vi.fn(async () => ({ pid: 123, uid: Number.NaN, gid: 0 })),
    ];

    for (const resolvePeerCredentials of resolvers) {
      const downstream = vi.fn(async () => "must-not-run");
      await expect(runProductionLoadTestControlAfterPeerAuthorization({
        socket,
        signal: new AbortController().signal,
        resolvePeerCredentials,
        authorized: downstream,
      })).rejects.toThrow("peer_unauthorized");
      expect(downstream).not.toHaveBeenCalled();
    }
  });

  it("does not authorize work after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const downstream = vi.fn(async () => "must-not-run");
    await expect(runProductionLoadTestControlAfterPeerAuthorization({
      socket,
      signal: controller.signal,
      resolvePeerCredentials: vi.fn(async () => ({ pid: 4321, uid: 0, gid: 0 })),
      authorized: downstream,
    })).rejects.toThrow("peer_unauthorized");
    expect(downstream).not.toHaveBeenCalled();
  });

  it("waits for child close so stdout delivered after exit is still authenticated", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdout,
      stderr,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const pending = collectProductionLoadPeerCredentialsOnChildClose(
      child,
      new AbortController().signal,
    );
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    stdout.write('{"pid":4321,"uid":0,"gid":0}\n');
    stdout.end();
    stderr.end();
    child.emit("close", 0, null);

    await expect(pending).resolves.toEqual({ pid: 4321, uid: 0, gid: 0 });
    expect(child.kill).not.toHaveBeenCalled();
  });
});
