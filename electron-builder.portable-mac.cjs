const { build } = require('./package.json')

module.exports = {
  ...build,
  mac: {
    ...build.mac,
    artifactName: 'KiraAI-Launcher-Portable-${version}-${arch}.${ext}',
    publish: build.publish.map((configuration) => ({ ...configuration, publishAutoUpdate: false })),
  },
  extraMetadata: {
    ...build.extraMetadata,
    kiraPortable: true,
  },
}
