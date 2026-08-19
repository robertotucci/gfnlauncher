/**
 * The slice of `@homebridge/dbus-native` this launcher uses.
 *
 * The package ships no types. Rather than pull in a generated set for an API
 * surface of five calls, the five are declared here — which doubles as the
 * documentation for a library whose own is thin, and keeps anything we have not
 * deliberately reached for out of reach.
 *
 * The fork rather than `dbus-next`: `dbus-next` carries an optional `usocket`
 * dependency that drags `node-gyp` and the abandoned `request` package into the
 * dependency tree, and every one of those tarballs would end up declared in
 * `flatpak/generated-sources.json` and shipped inside the Flatpak. This one is
 * pure JavaScript all the way down.
 */
declare module '@homebridge/dbus-native' {
  /** A decoded D-Bus message. Only the fields the portal client reads. */
  export interface DBusMessage {
    readonly path?: string
    readonly interface?: string
    readonly member?: string
    readonly body?: unknown[]
  }

  export interface DBusConnection {
    on(event: 'message', listener: (message: DBusMessage) => void): void
    on(event: 'error', listener: (error: Error) => void): void
    off(event: 'message', listener: (message: DBusMessage) => void): void
    end(): void
  }

  export interface InvokeOptions {
    readonly destination: string
    readonly path: string
    readonly interface: string
    readonly member: string
    /** Omitted for a call with no arguments. */
    readonly signature?: string
    readonly body?: unknown[]
  }

  export interface MessageBus {
    /**
     * The connection's unique name, e.g. `:1.219`.
     *
     * **Undefined until the first call completes.** It is assigned when the
     * `Hello` reply lands, and the library exposes no event for that — so
     * anything that needs it has to make a call first. `portalSenderToken`
     * refuses an undefined name rather than building a path out of it.
     */
    readonly name?: string
    readonly connection: DBusConnection
    invoke(
      options: InvokeOptions,
      callback: (error: Error | null, ...result: unknown[]) => void
    ): void
    addMatch(rule: string, callback?: (error: Error | null) => void): void
    removeMatch(rule: string, callback?: (error: Error | null) => void): void
  }

  export function sessionBus(): MessageBus
}
