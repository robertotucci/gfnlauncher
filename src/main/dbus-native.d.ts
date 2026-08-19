/**
 * The slice of `@homebridge/dbus-native` this launcher uses.
 *
 * The package ships no types. Rather than pull in a generated set for an API
 * surface of a handful of calls, they are declared here — which doubles as the
 * documentation for a library whose own is thin, and keeps anything we have not
 * deliberately reached for out of reach.
 *
 * It sits at the top of `src/main/` rather than beside one feature because
 * there are now two D-Bus clients in this process: `pointer/portal.ts`, on the
 * **session** bus, for `org.freedesktop.portal.RemoteDesktop`; and
 * `bluetooth/bluez.ts`, on the **system** bus, for `org.bluez`.
 *
 * The fork rather than `dbus-next`: `dbus-next` carries an optional `usocket`
 * dependency that drags `node-gyp` and the abandoned `request` package into the
 * dependency tree, and every one of those tarballs would end up declared in
 * `flatpak/generated-sources.json` and shipped inside the Flatpak. This one is
 * pure JavaScript all the way down.
 */
declare module '@homebridge/dbus-native' {
  /** A decoded D-Bus message. Only the fields this codebase reads. */
  export interface DBusMessage {
    readonly path?: string
    readonly interface?: string
    readonly member?: string
    readonly sender?: string
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

  /**
   * An interface descriptor for `exportInterface`.
   *
   * `methods` maps a member name onto `[inputSignature, outputSignature]`; the
   * library reads the second element to encode whatever the handler returned,
   * and an empty string means "no reply body". A handler may return a promise,
   * which is what lets an `org.bluez.Agent1` hold a pairing open until the user
   * has answered — and throwing an object carrying `dbusName` is how it sends a
   * real D-Bus error back rather than a generic failure.
   */
  export interface InterfaceDescriptor {
    readonly name: string
    readonly methods: Record<string, readonly [string, string]>
    readonly signals?: Record<string, readonly string[]>
    readonly properties?: Record<string, string>
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
    /**
     * Publishes `obj` as `iface` at `path` on this connection.
     *
     * Every member named in `iface.methods` must exist on `obj`. The library
     * does not check that at export time — a missing one answers
     * `org.freedesktop.DBus.Error.UnknownMethod` at call time, which for a
     * pairing agent presents as a pairing that silently fails.
     */
    exportInterface(obj: object, path: string, iface: InterfaceDescriptor): void
  }

  export function sessionBus(): MessageBus
  /**
   * Connects to `$DBUS_SYSTEM_BUS_ADDRESS`, falling back to
   * `/var/run/dbus/system_bus_socket`.
   *
   * That fallback is what works inside the Flatpak too: the runtime symlinks
   * `/var/run` to `/run`, and flatpak bind-mounts its filtered proxy over
   * `/run/dbus/system_bus_socket`, so the sandbox reaches the proxy through
   * exactly the same path the host reaches the bus through.
   */
  export function systemBus(): MessageBus
}
