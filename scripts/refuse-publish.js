console.error(
    'This fork does not publish to the Visual Studio Marketplace. ' +
    'The publisher id is unchanged so a local install can replace the upstream extension id, ' +
    'but publishing from this repository is refused.'
);
process.exit(1);
