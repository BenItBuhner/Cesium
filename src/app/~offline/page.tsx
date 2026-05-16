export default function OfflinePage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-[#191919] px-6 text-center text-white">
      <h1 className="text-lg font-semibold tracking-tight">You are offline</h1>
      <p className="max-w-sm text-sm text-[#6f6f6f]">
        Cesium needs a network connection for this session. Reconnect and try
        again.
      </p>
    </div>
  );
}
