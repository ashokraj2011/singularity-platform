"use client";
import { Suspense } from "react";
import { JourneyMapScreen } from "@/components/synthesis/screens/JourneyMapScreen";
export default function JourneyPage() { return <Suspense fallback={null}><JourneyMapScreen /></Suspense>; }
