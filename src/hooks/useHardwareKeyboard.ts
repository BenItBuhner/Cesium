"use client";

import { useSyncExternalStore } from "react";
import { useViewport } from "@/hooks/useViewport";

function subscribe(callback: () => void): () => void {
	const mq = window.matchMedia("(any-pointer: fine)");
	mq.addEventListener("change", callback);
	window.addEventListener("keyboardconnect", callback as EventListener);
	window.addEventListener("keyboarddisconnect", callback as EventListener);
	return () => {
		mq.removeEventListener("change", callback);
		window.removeEventListener("keyboardconnect", callback as EventListener);
		window.removeEventListener("keyboarddisconnect", callback as EventListener);
	};
}

function getSnapshot(): boolean {
	if (typeof navigator === "undefined") return true;
	if (window.matchMedia("(any-pointer: fine)").matches) return true;
	return false;
}

function getServerSnapshot(): boolean {
	return true;
}

export function useHardwareKeyboard(): boolean {
	const { isMobile } = useViewport();
	const hasFinePointer = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	if (isMobile) return hasFinePointer;
	return true;
}
