import path from "path";
import type { CodeFixAction, Diagnostic, FileTextChanges, getDefaultFormatCodeSettings, TextChange } from "typescript";
import os, { hostname } from "os";
import fs from "fs";
import _ from "lodash";
import { createProject, Project } from "./ts";
// export const tsConfigFilePathDefault = path.resolve(__dirname, "../test/exampleTest/tsconfig.json");
// const outputFolderDefault = path.resolve(__dirname, "../test/exampleTestOutput");

export interface Logger {
  (...args: any[]): void;
  error?(...args: any[]): void;
  warn?(...args: any[]): void;
  info?(...args: any[]): void;
  verbose?(...args: any[]): void;
}

export interface Host {
  writeFile(fileName: string, content: string): void;
  log: Logger;
}

class TestHost implements Host {
    private filesWritten = new Map<string, string>();
    private logged = <string[]>[];
    log(s:string) {this.logged.push(s)};
    writeFile(fileName: string, content: string) {
        this.filesWritten.set(fileName, content);
    }

    getChangedFile(fileName: string) {
        return this.filesWritten.get(fileName);
    }
}


export interface Options {
  tsconfigPath: string;
  outputFolder: string;
  errorCode: number[];
  fixName: string[];
}

export async function codefixProject(opt:Options, host: Host) {
  const firstPassLeftover = await applyCodefixesOverProject(opt, host);

  // if overlap/non executed changes for some reason, redo process 
  if (firstPassLeftover.length > 0) {
    // maybe in applycodefixesoverproject we have an exit if no changes?
    // maybe emit some sort of diagnostic/statement? 
    // might need some other type/flag with more options besides boolean 
    return applyCodefixesOverProject(opt, host);
  }
  host;

  // host.log("blah blah blah");
  // host.log.verbose("asdfasdfasdf");

  return firstPassLeftover;
}

export async function applyCodefixesOverProject(opt: Options, host: Host): Promise<TextChange[]> {
  // tsconfigPath: string, errorCode?: number|undefined
  // get project object
  const project = createProject({ tsConfigFilePath: opt.tsconfigPath });
  if (!project) {
    // TODO: graceful error message reporting
    throw new Error("Could not create project");
  }

  // pull all codefixes.
  const diagnosticsPerFile = await getDiagnostics(project);

  if (diagnosticsPerFile === [] || diagnosticsPerFile === [[]]){
    host.log("No more diagnostics.");
    return [];
  }
  // pull codefixes from diagnostics.  If errorCode is specified, only pull fixes for that/those errors. 
  //    Otherwise, pull all fixes

  const [filteredDiagnostics, acceptedDiagnosticsOut] =  filterDiagnosticsByErrorCode(diagnosticsPerFile,opt);
  acceptedDiagnosticsOut.forEach(string_describe => {
    host.log(string_describe);
  });

  const codefixesPerFile = filteredDiagnostics.map(function (d) {
    return (getCodeFixesForFile(project, d, opt)); 
  });
  const codefixes = <CodeFixAction[]>_.flatten(codefixesPerFile);

  // filter for codefixes if applicable, then 
  //    organize textChanges by what file they alter
  const textChangesByFile = getTextChangeDict(codefixes, opt);

  // edit each file
  let leftoverChanges = doAllTextChanges(project, textChangesByFile, opt, host);
  // figure out returns alater....
  return leftoverChanges;
}

export function getDiagnostics(project: Project): (readonly Diagnostic[])[] {
  const diagnostics = project.program.getSourceFiles().map(function (file) {
    return project.program.getSemanticDiagnostics(file);
  });
  return diagnostics;
}


export function filterDiagnosticsByErrorCode(diagnostics: (readonly Diagnostic[])[], opt:Options): [(readonly Diagnostic[])[], string[]]{
  // if errorCodes were passed in, only use the specified errors
  // diagnostics is guarenteed to not be [] or [[]]
  if (opt.errorCode.length !== 0) {

    let errorCounter = new Map<number, number>();
    let filteredDiagnostics = <(readonly Diagnostic[])[]>[];
    for (let i = 0; i < diagnostics.length; i++) {
      //for every diagnostic list

      // get rid of not matched errors 
      const filteredDiagnostic =  _.filter(diagnostics[i], function (d) {
        if (opt.errorCode.includes(d.code)) {
          const currentVal =  errorCounter.get(d.code) ;
          if (currentVal!== undefined) {
            errorCounter.set(d.code, currentVal +1); 
          } else {
            errorCounter.set(d.code, 1); 
          }
          return true;
        } 
        return false;
      });
      filteredDiagnostics.push(filteredDiagnostic);
    }
    let returnStrings = <string[]> [];
    errorCounter.forEach((count, code) => {
      returnStrings.push( "found " + count + " diagnostics with code " + code );
    })
    
    if (returnStrings.length === 0) {
      return [[], ["no diagnostics found with codes " + opt.errorCode.toString()]];
    }
    return [filteredDiagnostics, returnStrings];
  }
  // otherwise, use all errors
  return [diagnostics, ["found " + _.reduce(diagnostics.map((d) => d.length), function(sum, n) {
      return sum + n;}, 0) + " diagnostics in " + diagnostics.length + " files"]];
}

export function getCodeFixesForFile(project: Project, diagnostics: readonly Diagnostic[], opt: Options): readonly CodeFixAction[] {
  // expects already filtered diagnostics
  const service = project.languageService;
  const codefixes = (<CodeFixAction[]>[]).concat.apply([], diagnostics.map(function (d) {
    if (d.file && d.start !== undefined && d.length !== undefined) {
      return service.getCodeFixesAtPosition(
        d.file.fileName,
        d.start,
        d.start + d.length,
        [d.code],
        project.ts.getDefaultFormatCodeSettings(os.EOL),
        {});
    } else {
      return [];
    }
  })).filter(d => d !== undefined);
  opt
  return codefixes;
}

function getFileTextChangesFromCodeFix(codefix: CodeFixAction): readonly FileTextChanges[] {
  return codefix.changes;
}

export function getTextChangeDict(codefixes: readonly CodeFixAction[], opt: Options): Map<string, TextChange[]> {
  let textChangeDict = new Map<string, TextChange[]>();

  const filteredFixes = filterCodeFixesByFixName(codefixes, opt);
  for (let i = 0; i < filteredFixes.length; i++) {
    const fix = filteredFixes[i];
    const changes = getFileTextChangesFromCodeFix(fix);

    for (let j = 0; j < changes.length; j++) {
      let change = changes[j];
      let [key, value] = getFileNameAndTextChangesFromCodeFix(change);

      const prevVal = textChangeDict.get(key);
      if (prevVal === undefined) {
        textChangeDict.set(key, value);
      } else {
        textChangeDict.set(key, prevVal.concat(value));
      }
    }
  }

  return textChangeDict;
}

export function filterCodeFixesByFixName(codefixes: readonly CodeFixAction[], opt: Options): readonly CodeFixAction[] { //tested
  if (opt.fixName.length === 0) {
    // empty argument behavior... currently, we just keep all fixes if none are specified
    return codefixes;
  }
  // cannot sort by fixId right now since fixId is a {}
  // do we want to distinguish the case when no codefixes are picked? (no hits)
  return codefixes.filter(function (codefix) {return  opt.fixName.includes(codefix.fixName);});
}

function getFileNameAndTextChangesFromCodeFix(ftchanges: FileTextChanges): [string, TextChange[]] {
  return [ftchanges.fileName, [...ftchanges.textChanges]];
}

function doAllTextChanges(project: Project, textChanges: Map<string, TextChange[]>, opt: Options, host: Host): TextChange[] {
  let notAppliedChanges =<TextChange[]>[];
  textChanges.forEach((fileFixes, fileName) => {
    const sourceFile = project.program.getSourceFile(fileName);

    if (sourceFile !== undefined) {
      const originalFileContents = sourceFile.text;

      // collision is true if there were changes that were not applied 
      // also performs the writing to the file
      let [out, newFileContents] = applyCodefixesInFile(originalFileContents, fileFixes);
      notAppliedChanges = out;
      writeToFile(fileName, newFileContents, opt, host);
    }

    else {
      throw new Error('file ' + fileName + ' not found in project');
    }
  });

  return notAppliedChanges;
}

function applyCodefixesInFile(originalContents: string, textChanges: TextChange[]):  [TextChange[], string] {
  // sort textchanges by start
  const sortedFixList = sortChangesByStart(textChanges);

  // take some sort of issue (or none) with overlapping textchanges
  const [filteredFixList, notAppliedFixes] = filterOverlappingFixes(sortedFixList);

  // apply all remaining textchanges
  const newFileContents = applyChangestoFile(originalContents, filteredFixList);
  
  // return 
  // if all fixes have been applied, then it is False that we expect to do another pass
  return [notAppliedFixes, newFileContents];
}

export function sortChangesByStart(textChanges: TextChange[]) : TextChange[] { // tested
  // what if two changes start at the same place but have differnt lengths?
      // currently the shorter one is put first 
      // ignores text content of the changes
  return textChanges.sort((a, b) => {
    return (a.span.start - b.span.start === 0) ? a.span.length - b.span.length : a.span.start - b.span.start 
});
}


export function filterOverlappingFixes(sortedFixList: TextChange[]): [TextChange[], TextChange[]] { // tested
  let filteredList = <TextChange[]>[];
  let droppedList = <TextChange[]>[];
  let currentEnd = -1;
  // why is 'fix' in the line below a string[], while sortedFixList is Textchange[]?

  for (let i = 0; i < sortedFixList.length; i++) {
    let fix = sortedFixList[i];
    if (fix.span.start > currentEnd) {
      filteredList.push(fix);
      currentEnd = fix.span.start + fix.span.length;
    } else {
      droppedList.push(fix);
    }
  }
  return [filteredList, droppedList];
}

function applyChangestoFile(originalContents: string, fixList: TextChange[]): string {
  // maybe we want to have this and subsequent functions to return a diagnostic
  // function expects fixList to be already sorted and filtered
  const newFileContents = doTextChanges(originalContents, fixList);
  return newFileContents;
}

export function doTextChanges(fileText: string, textChanges: readonly TextChange[]): string {
  // does js/ts do references? Or is it always a copy when you pass into a function
  // iterate through codefixes from back
  for (let i = textChanges.length - 1; i >= 0; i--) {
    // apply each codefix
    fileText = doTextChangeOnString(fileText, textChanges[i]);
  }
  return fileText;
}

export function doTextChangeOnString(currentFileText: string, change: TextChange): string { // tested
  const prefix = currentFileText.substring(0, change.span.start);
  const middle = change.newText;
  const suffix = currentFileText.substring(change.span.start + change.span.length);
  return prefix + middle + suffix;
}


function writeToFile(fileName: string, fileContents: string, opt: Options, host:Host): void {
  const writeToFileName = getOutputFilePath(fileName, opt);
  const writeToDirectory =getDirectory(writeToFileName)
  if (!fs.existsSync(writeToDirectory)) {
    createDirectory(writeToDirectory);
  }
  host.writeFile(writeToFileName , fileContents);
  host.log("Updated " + writeToFileName); //TODo: the print statment >:
}

function createDirectory(directoryPath: string) {
  fs.mkdir(directoryPath, {recursive :true}, () => {});
}

// TODO: !!! aah ok so i dont know if i need these down here anymore... restructuring needed?

function getOutputFilePath(filePath: string, opt: Options): string {
  const fileName = getRelativePath(filePath, opt);
  return path.resolve(opt.outputFolder, fileName);
}

export function getFileName(filePath: string): string {
  return filePath.replace(/^.*[\\\/]/, '');
}

export function getDirectory(filePath:string) :string {
  return filePath.substring(filePath.length - getFileName(filePath).length)
}

function getOutputBaseFolder(opt: Options):string {
  return opt.outputFolder;
}

export function getRelativePath(filePath: string, opt: Options): string{ 
  return path.relative(getDirectory(opt.tsconfigPath), filePath);
}
