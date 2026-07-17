"use client";
import { Suspense } from "react";
import { DiagramWorkspaceScreen } from "@/components/synthesis/screens/DiagramWorkspaceScreen";
export default function DiagramsPage() { return <Suspense fallback={null}><DiagramWorkspaceScreen /></Suspense>; }
