"use client";

import { useParams } from "next/navigation";
import { TaskDetailPanel } from "@/app/_components/TaskDetailPanel";

export default function TaskDetailPage() {
  const params = useParams();
  const id = params.id as string;
  return <TaskDetailPanel id={id} />;
}
