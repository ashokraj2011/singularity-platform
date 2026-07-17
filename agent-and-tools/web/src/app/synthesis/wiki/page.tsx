"use client";
import { Suspense } from "react";
import { ProjectWikiScreen } from "@/components/synthesis/screens/ProjectWikiScreen";
export default function WikiPage() { return <Suspense fallback={null}><ProjectWikiScreen /></Suspense>; }
