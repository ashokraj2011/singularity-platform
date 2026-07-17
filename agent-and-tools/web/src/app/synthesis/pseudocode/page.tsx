"use client";
import { Suspense } from "react";
import { PseudoCodeStudioScreen } from "@/components/synthesis/screens/PseudoCodeStudioScreen";
export default function PseudoCodePage() { return <Suspense fallback={null}><PseudoCodeStudioScreen /></Suspense>; }
