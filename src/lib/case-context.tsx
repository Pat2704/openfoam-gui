'use client';

import { createContext, useContext, useState, useCallback } from 'react';

export interface ActiveFile {
  path: string;
  content: string;
}

interface CaseContextType {
  caseName: string | null;
  setCaseName: (name: string | null) => void;
  activeFile: ActiveFile | null;
  setActiveFile: (file: ActiveFile | null) => void;
  /**
   * The File Editor's open file while it has unsaved edits, else null. The
   * editor is remounted for every case, so switching or renaming the open case
   * discards its buffer; whatever does either asks first when this is set.
   */
  unsavedFile: string | null;
  setUnsavedFile: (path: string | null) => void;
}

const CaseContext = createContext<CaseContextType>({
  caseName: null,
  setCaseName: () => {},
  activeFile: null,
  setActiveFile: () => {},
  unsavedFile: null,
  setUnsavedFile: () => {},
});

export function CaseProvider({ children }: { children: React.ReactNode }) {
  const [caseName, setCaseName] = useState<string | null>(null);
  const [activeFile, setActiveFileState] = useState<ActiveFile | null>(null);
  const [unsavedFile, setUnsavedFile] = useState<string | null>(null);

  const setActiveFile = useCallback((file: ActiveFile | null) => {
    setActiveFileState(file);
  }, []);

  return (
    <CaseContext.Provider value={{ caseName, setCaseName, activeFile, setActiveFile, unsavedFile, setUnsavedFile }}>
      {children}
    </CaseContext.Provider>
  );
}

export function useCaseName() {
  return useContext(CaseContext).caseName;
}

export function useCaseContext() {
  return useContext(CaseContext);
}