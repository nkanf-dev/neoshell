import React, { useState, type FormEvent } from "react";
import { LockKeyhole, Workflow } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

type LoginScreenProps = {
  onLogin: (username: string, password: string) => Promise<void> | void;
};

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      await onLogin(username.trim(), password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Login failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 sm:p-6">
      <Card className="w-full max-w-lg border bg-card shadow-sm">
        <CardHeader className="space-y-4 border-b bg-muted/20 px-6 py-6">
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border bg-primary/10 text-primary">
              <Workflow className="h-4 w-4" />
            </div>
            <div>
              <CardTitle className="text-2xl tracking-tight">neoshell control plane</CardTitle>
              <CardDescription>Browser-first PowerShell agent with hard auth boundaries.</CardDescription>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary" className="rounded-full">
              Plan aware
            </Badge>
            <Badge variant="secondary" className="rounded-full">
              Secured
            </Badge>
            <Badge variant="secondary" className="rounded-full">
              Live SSE
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="grid gap-5 px-6 py-6">
          <div className="grid gap-2 text-sm text-muted-foreground">
            <p>Sign in through the backend auth endpoint. Local development can use demo credentials.</p>
            <p className="flex items-center gap-2 text-foreground">
              <LockKeyhole className="h-4 w-4 text-muted-foreground" />
              Keep remote access behind a hard auth boundary.
            </p>
          </div>

          <Separator />

          <form className="grid gap-4" onSubmit={handleSubmit}>
            <div className="grid gap-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                spellCheck={false}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </div>

            {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p> : null}

            <Button type="submit" className="h-10" disabled={pending}>
              {pending ? "Signing in..." : "Open neoshell"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
