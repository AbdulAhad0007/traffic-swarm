import shutil,sys,importlib.util
checks={'python':shutil.which('python'),'sumo':shutil.which('sumo'),'netconvert':shutil.which('netconvert'),'maven':shutil.which('mvn'),'npm':shutil.which('npm'),'docker':shutil.which('docker')}
for k,v in checks.items(): print(f'{k.upper():12} '+('OK' if v else 'MISSING'))
print('TraCI       '+('OK' if importlib.util.find_spec('traci') else 'MISSING'))
