import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell/AppShell.tsx";
import { BoardPlaceholder } from "./shell/BoardPlaceholder.tsx";
import RoutePlaceholder from "./routes/RoutePlaceholder.tsx";
import { NotFound } from "./routes/NotFound.tsx";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<BoardPlaceholder />} />
          <Route
            path="tickets/:id"
            element={<RoutePlaceholder title="Ticket detail" stepRef="step 11" />}
          />
          <Route
            path="prs/:id"
            element={<RoutePlaceholder title="PR detail" stepRef="step 11" />}
          />
          <Route
            path="activity"
            element={<RoutePlaceholder title="Activity log" stepRef="step 11" />}
          />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
