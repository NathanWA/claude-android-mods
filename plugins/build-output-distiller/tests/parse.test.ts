import { describe, expect, test } from 'claude-code/testing'

import { analyzeCommand, isTestTask } from '../hooks/command'
import { parseOutput } from '../hooks/parse'

describe('parseOutput', () => {
  test('Kotlin 1.x and build-script errors', () => {
    const parsed = parseOutput(
      [
        'e: /work/acme/app/src/main/java/com/acme/Foo.kt: (12, 5): Unresolved reference: bar',
        'e: file:///work/acme/app/build.gradle.kts:12:20: Unresolved reference: libz',
      ].join('\n'),
    )
    expect(parsed.errors).toEqual([
      { kind: 'kotlin', file: '/work/acme/app/src/main/java/com/acme/Foo.kt', line: 12, column: 5, message: 'Unresolved reference: bar' },
      { kind: 'kotlin', file: '/work/acme/app/build.gradle.kts', line: 12, column: 20, message: 'Unresolved reference: libz' },
    ])
  })

  test('AAPT, R8 and the manifest merger', () => {
    const parsed = parseOutput(
      [
        'ERROR: /work/acme/app/src/main/res/layout/activity_main.xml:12: AAPT: error: resource string/missing (aka com.acme:string/missing) not found.',
        'ERROR: Missing classes detected while running R8. Please add the missing classes or apply additional keep rules that are generated in /work/acme/app/build/outputs/mapping/release/missing_rules.txt.',
        'ERROR: R8: Missing class com.google.errorprone.annotations.Immutable (referenced from: com.google.crypto.tink.KeysetHandle and 1 other context)',
        '/work/acme/app/src/main/AndroidManifest.xml:12:9-35 Error:',
        '\tAttribute application@allowBackup value=(false) from AndroidManifest.xml:12:9-35',
        '\tis also present at [com.lib:lib:1.0] AndroidManifest.xml:9:18-44 value=(true).',
      ].join('\n'),
    )
    expect(parsed.errors).toEqual([
      {
        kind: 'aapt',
        file: '/work/acme/app/src/main/res/layout/activity_main.xml',
        line: 12,
        column: undefined,
        message: 'resource string/missing (aka com.acme:string/missing) not found.',
      },
      {
        kind: 'r8',
        message: 'Missing class com.google.errorprone.annotations.Immutable (referenced from com.google.crypto.tink.KeysetHandle and 1 other context)',
      },
      {
        kind: 'manifest',
        file: '/work/acme/app/src/main/AndroidManifest.xml',
        line: 12,
        column: 9,
        message: 'Attribute application@allowBackup value=(false) from AndroidManifest.xml:12:9-35',
        detail: ['is also present at [com.lib:lib:1.0] AndroidManifest.xml:9:18-44 value=(true).'],
      },
    ])
    expect(parsed.missingRules).toBe('/work/acme/app/build/outputs/mapping/release/missing_rules.txt')
  })

  test('Room through KSP and Dagger through kapt', () => {
    const parsed = parseOutput(
      [
        'e: [ksp] /work/acme/core/data/src/main/java/com/acme/UserDao.kt:20: There is a problem with the query: [SQLITE_ERROR] SQL error or missing database (no such table: users)',
        '/work/acme/app/build/tmp/kapt3/stubs/debug/com/acme/App_HiltComponents.java:130: error: [Dagger/MissingBinding] com.acme.Repo cannot be provided without an @Inject constructor or an @Provides-annotated method.',
      ].join('\n'),
    )
    expect(parsed.errors.map(error => [error.kind, error.line])).toEqual([
      ['room', 20],
      ['dagger', 130],
    ])
  })

  test('a build script error located by * Where:', () => {
    const parsed = parseOutput(
      [
        'FAILURE: Build failed with an exception.',
        '',
        '* Where:',
        "Build file '/work/acme/app/build.gradle.kts' line: 3",
        '',
        '* What went wrong:',
        "Plugin [id: 'com.acme.missing'] was not found in any of the following sources:",
        '',
        '* Try:',
        '> Run with --stacktrace option to get the stack trace.',
        '',
        'BUILD FAILED in 2s',
      ].join('\n'),
    )
    expect(parsed.outcome).toBe('failed')
    expect(parsed.errors).toEqual([
      {
        kind: 'gradle',
        file: '/work/acme/app/build.gradle.kts',
        line: 3,
        message: "Plugin [id: 'com.acme.missing'] was not found in any of the following sources:",
      },
    ])
    expect(parsed.wentWrong).toEqual([["Plugin [id: 'com.acme.missing'] was not found in any of the following sources:"]])
  })
})

describe('analyzeCommand', () => {
  test('finds the Gradle call, its tasks and directory', () => {
    expect(analyzeCommand('cd android && JAVA_HOME=/opt/jdk17 ./gradlew :app:testDebugUnitTest --tests "com.acme.*"')).toMatchObject({
      tasks: [':app:testDebugUnitTest'],
      workDir: 'android',
      isPassthrough: false,
      rewritten: 'cd android && JAVA_HOME=/opt/jdk17 ./gradlew :app:testDebugUnitTest --tests "com.acme.*" --console=plain',
    })
    expect(analyzeCommand('gradle -p mobile assembleRelease')).toMatchObject({ tasks: ['assembleRelease'], workDir: 'mobile' })
  })

  test('appends the console flag only where it lands on the Gradle call', () => {
    expect(analyzeCommand('./gradlew build | tail -50')?.rewritten).toBe('./gradlew build | tail -50')
    expect(analyzeCommand('./gradlew build 2>&1')?.rewritten).toBe('./gradlew build 2>&1')
    expect(analyzeCommand('./gradlew build --console=rich')?.rewritten).toBe('./gradlew build --console=rich')
  })

  test('leaves answers and endless runs alone', () => {
    for (const command of [
      './gradlew :app:dependencies --configuration releaseRuntimeClasspath',
      './gradlew tasks --all',
      './gradlew signingReport',
      './gradlew properties',
      './gradlew --version',
      './gradlew --continuous test',
      './gradlew',
    ]) {
      expect(analyzeCommand(command)?.isPassthrough, command).toBe(true)
    }
    expect(analyzeCommand('cat app/build.gradle')).toBeUndefined()
    expect(analyzeCommand('ls gradle/')).toBeUndefined()
  })

  test('tells test runs from tasks that only build tests', () => {
    expect(['test', ':app:testDebugUnitTest', 'jvmTest', 'connectedDebugAndroidTest', 'allTests'].map(isTestTask)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ])
    expect(['compileDebugUnitTestKotlin', 'assembleDebugAndroidTest', 'packageDebugAndroidTest', 'testClasses'].map(isTestTask)).toEqual([
      false,
      false,
      false,
      false,
    ])
  })
})
