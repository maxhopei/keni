import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell/AppShell.tsx";
import { BoardView } from "./features/board/BoardView.tsx";
import { TicketDetailView } from "./features/ticketDetail/TicketDetailView.tsx";
import { PRDetailView } from "./features/prDetail/PRDetailView.tsx";
import { ActivityLogView } from "./features/activityLog/ActivityLogView.tsx";
import { NotFound } from "./routes/NotFound.tsx";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<BoardView />} />
          <Route path="tickets/:id" element={<TicketDetailView />} />
          <Route path="prs/:id" element={<PRDetailView />} />
          <Route path="activity" element={<ActivityLogView />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
